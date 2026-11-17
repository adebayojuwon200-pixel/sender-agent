import type { Classification, MailMessage, QueueItem, Step, World } from "./types.ts";

export const DAILY_CAP = 10;
export const MIN_GAP_MINUTES = 25;
export const RECONTACT_DAYS = 90;
export const BOUNCE_LOOKBACK_DAYS = 60;
export const DEFAULT_TZ = "Africa/Lagos";

const DAY_MS = 86_400_000;

export const domainOf = (address: string): string => address.split("@")[1]?.toLowerCase() ?? "";
export const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
export const isMailerDaemon = (address: string): boolean => /^(mailer-daemon|postmaster)@/i.test(address.trim());
export const utcDate = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

export function ourMessagesNeeded(step: Step): number {
  return step === "FIRST" ? 0 : step === "FU1" ? 1 : 2;
}

export function localTime(nowIso: string, tz: string): { weekday: string; minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowIso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return { weekday: get("weekday"), minutes: hour * 60 + minute, label: `${get("weekday")} ${get("hour")}:${get("minute")} ${tz}` };
}

export function inOfficeHours(nowIso: string, tz: string | null): boolean {
  const t = localTime(nowIso, tz ?? DEFAULT_TZ);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(t.weekday) && t.minutes >= 9 * 60 && t.minutes <= 17 * 60;
}

export function runState(world: World) {
  const today = utcDate(world.now);
  const sends = world.sendLog.filter((e) => e.result.startsWith("sent"));
  const sentToday = sends.filter((e) => utcDate(e.when) === today).length;
  const last = sends.map((e) => Date.parse(e.when)).sort((a, b) => b - a)[0];
  const minutesSinceLastSend = last === undefined ? null : Math.floor((Date.parse(world.now) - last) / 60_000);
  return { now: world.now, hold: world.hold, sentToday, dailyCap: DAILY_CAP, minutesSinceLastSend, minGapMinutes: MIN_GAP_MINUTES };
}

export function stopReason(world: World): "hold" | "daily cap" | "too soon" | null {
  const s = runState(world);
  if (s.hold) return "hold";
  if (s.sentToday >= DAILY_CAP) return "daily cap";
  if (s.minutesSinceLastSend !== null && s.minutesSinceLastSend < MIN_GAP_MINUTES) return "too soon";
  return null;
}

export function nextItem(world: World): QueueItem | null {
  const today = utcDate(world.now);
  return (
    world.queue.find((q) => q.status === "queued" && q.due <= today && inOfficeHours(world.now, q.tz)) ?? null
  );
}

export function fillTemplate(template: string, item: QueueItem): string {
  return template.replace("[greeting]", item.greeting).replaceAll("[Org]'s", item.orgPossessive);
}

export function approvedText(world: World, item: QueueItem): string | null {
  if (item.step === "FIRST") return world.templates.first[item.id] ?? null;
  return fillTemplate(world.templates[item.step][item.audience], item);
}

export function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function lint(body: string) {
  const links = body.match(/https?:\/\/\S+|www\.\S+/gi) ?? [];
  const bareDomains = (body.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi) ?? []).filter(
    (d) => !links.some((l) => l.includes(d)),
  );
  const dashes = (body.match(/[–—]/g) ?? []).length;
  return { links, bareDomains, dashes, clean: links.length === 0 && bareDomains.length === 0 && dashes === 0 };
}

export function compareText(actual: string, approved: string) {
  const a = normalize(actual).split("\n\n");
  const b = normalize(approved).split("\n\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a.at(i) !== b.at(i)) {
      return { matches: false, firstDifference: { paragraph: i + 1, approved: b.at(i) ?? null, actual: a.at(i) ?? null } };
    }
  }
  return { matches: true, firstDifference: null };
}

export function outgoingBody(world: World, item: QueueItem): { source: "draft" | "template"; body: string | null } {
  if (item.draftId) return { source: "draft", body: world.drafts[item.draftId]?.body ?? null };
  return { source: "template", body: approvedText(world, item) };
}

export function checkOutgoing(world: World, item: QueueItem) {
  const approved = approvedText(world, item);
  const out = outgoingBody(world, item);
  if (approved === null) return { source: out.source, approvedFound: false, matches: false, firstDifference: null, lint: null };
  if (out.body === null) return { source: out.source, approvedFound: true, matches: false, firstDifference: { paragraph: 0, approved: "(draft)", actual: "draft not found" }, lint: null };
  return { source: out.source, approvedFound: true, ...compareText(out.body, approved), lint: lint(out.body) };
}

export function contactListHits(world: World, address: string) {
  const domain = domainOf(address);
  const hit = (entry: string) => sameAddress(entry, address) || entry.trim().toLowerCase() === domain;
  return { doNotContact: world.doNotContact.filter(hit), positivePartner: world.positivePartners.filter(hit) };
}

export function allOurSentMail(world: World): MailMessage[] {
  const fromThreads = Object.values(world.threads).flat().filter((m) => sameAddress(m.from, world.us));
  return [...fromThreads, ...world.sentArchive.filter((m) => !fromThreads.some((t) => t.id === m.id))];
}

export function recentContacts(world: World, domain: string, days = RECONTACT_DAYS) {
  const since = Date.parse(world.now) - days * DAY_MS;
  return allOurSentMail(world)
    .filter((m) => domainOf(m.to) === domain.toLowerCase() && Date.parse(m.date) >= since)
    .map((m) => ({ to: m.to, date: m.date, subject: m.subject }));
}

export function bounces(world: World, address: string, days = BOUNCE_LOOKBACK_DAYS) {
  const since = Date.parse(world.now) - days * DAY_MS;
  const all = [...world.inbox, ...Object.values(world.threads).flat()];
  const seen = new Set<string>();
  return all
    .filter((m) => isMailerDaemon(m.from) && Date.parse(m.date) >= since && m.body.toLowerCase().includes(address.toLowerCase()))
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .map((m) => ({ id: m.id, from: m.from, date: m.date, subject: m.subject }));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function checkClassifications(world: World, item: QueueItem, classified: Classification[]): string[] {
  const problems: string[] = [];
  const theirs = (world.threads[item.threadId] ?? []).filter((m) => !sameAddress(m.from, world.us));
  for (const m of theirs) {
    const c = classified.find((x) => x.message_id === m.id);
    if (!c) {
      problems.push(`message ${m.id} from ${m.from} was not classified`);
    } else if (c.kind === "human") {
      problems.push(`message ${m.id} is a reply from a person`);
    } else if (c.kind === "bounce" && !isMailerDaemon(m.from)) {
      problems.push(`message ${m.id} was called a bounce but is not from a mail server`);
    } else if (!c.evidence.trim() || !squash(m.body + " " + m.subject).includes(squash(c.evidence))) {
      problems.push(`the evidence quoted for message ${m.id} does not appear in it`);
    }
  }
  return problems;
}

export interface GuardContext {
  threadsRead: Set<string>;
  classified: Classification[];
}

/** Every rule a send must pass, checked in code. The model cannot talk its way past any of these. */
export function guardSend(world: World, item: QueueItem, ctx: GuardContext): string[] {
  const problems: string[] = [];
  const stop = stopReason(world);
  if (stop) problems.push(`run must stop: ${stop}`);
  if (item.status !== "queued") problems.push(`item status is "${item.status}", not queued`);
  if (item.due > utcDate(world.now)) problems.push(`item is not due until ${item.due}`);
  if (!inOfficeHours(world.now, item.tz)) problems.push(`outside the recipient's working hours (${localTime(world.now, item.tz ?? DEFAULT_TZ).label})`);
  if (!ctx.threadsRead.has(item.threadId)) problems.push("the thread was not read in this run");
  problems.push(...checkClassifications(world, item, ctx.classified));
  if (bounces(world, item.to).length > 0) problems.push("a bounce exists for this address");
  const ours = (world.threads[item.threadId] ?? []).filter((m) => sameAddress(m.from, world.us)).length;
  if (ours !== ourMessagesNeeded(item.step)) problems.push(`${item.step} needs ${ourMessagesNeeded(item.step)} earlier messages from us, the thread has ${ours}`);
  const lists = contactListHits(world, item.to);
  if (lists.doNotContact.length || lists.positivePartner.length) problems.push("the address or domain is on a contact list");
  if (item.step === "FIRST" && recentContacts(world, domainOf(item.to)).length > 0) problems.push(`someone at ${domainOf(item.to)} was contacted in the last ${RECONTACT_DAYS} days`);
  const text = checkOutgoing(world, item);
  if (!text.approvedFound) problems.push("no approved text exists for this item");
  else if (!text.matches) problems.push(`outgoing text differs from the approved text in paragraph ${text.firstDifference?.paragraph}`);
  else if (text.lint && !text.lint.clean) problems.push("outgoing text has a link, a bare domain or a dash");
  return problems;
}

export function addWorkingDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}
