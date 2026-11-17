import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS } from "../evals/scenarios.ts";
import { compareText, inOfficeHours, lint, nextItem, normalize, stopReason } from "../src/rules.ts";
import { ToolBox } from "../src/tools.ts";
import type { Classification, World } from "../src/types.ts";

const worldOf = (name: string): World => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return structuredClone(s.world);
};

const send = (box: ToolBox, item: string, classification: Classification[] = []) =>
  box.execute("send_email", { item_id: item, thread_classification: classification });

test("normalize ignores line wraps and extra spaces", () => {
  assert.equal(normalize("Hi Ada,\n\nOne line\nwrapped  here.\n\n\nSam"), "Hi Ada,\n\nOne line wrapped here.\n\nSam");
  assert.equal(compareText("A\nb\n\nC", "A b\n\nC").matches, true);
  assert.equal(compareText("A b\n\nC", "A c\n\nC").firstDifference?.paragraph, 1);
});

test("lint finds links, bare domains and dashes", () => {
  assert.equal(lint("See https://eodly.io/demo").links.length, 1);
  assert.deepEqual(lint("Visit eodly.io today").bareDomains, ["eodly.io"]);
  assert.equal(lint("Wait — one more").dashes, 1);
  assert.equal(lint("Worth up to $534 each, e.g. for founders.").clean, true);
});

test("working hours follow the recipient's time zone", () => {
  assert.equal(inOfficeHours("2026-11-16T10:00:00Z", "Europe/London"), true);
  assert.equal(inOfficeHours("2026-11-16T10:00:00Z", "America/Los_Angeles"), false);
  assert.equal(inOfficeHours("2026-11-15T10:00:00Z", "Europe/London"), false, "Sunday");
  assert.equal(inOfficeHours("2026-11-16T10:00:00Z", null), true, "defaults to Lagos");
});

test("the queue picker skips items outside working hours or not yet due", () => {
  assert.equal(nextItem(worldOf("outside-hours-first-in-queue"))?.id, "12");
  assert.equal(nextItem(worldOf("nothing-due")), null);
});

test("stop rules: hold, daily cap, minimum gap", () => {
  assert.equal(stopReason(worldOf("hold")), "hold");
  assert.equal(stopReason(worldOf("daily-cap")), "daily cap");
  assert.equal(stopReason(worldOf("too-soon")), "too soon");
  assert.equal(stopReason(worldOf("fu1-clean")), null);
});

test("a clean follow-up sends, logs, and queues the final note", () => {
  const box = new ToolBox(worldOf("fu1-clean"));
  box.execute("get_thread", { thread_id: "t12" });
  const r = send(box, "12");
  assert.equal(r.isError, false, r.content);
  assert.deepEqual(box.outcome?.action, "sent");
  const final = box.world.queue.find((q) => q.id === "12-final");
  assert.equal(final?.step, "FINAL");
  assert.equal(final?.due, "2026-11-19");
  assert.match(box.world.sendLog.at(-1)!.result, /^sent and checked/);
});

test("send is refused if the thread was never read", () => {
  const box = new ToolBox(worldOf("fu1-clean"));
  const r = send(box, "12");
  assert.equal(r.isError, true);
  assert.match(r.content, /thread was not read/);
  assert.equal(box.outcome, null);
});

test("a person's reply blocks the send even if the model calls it an auto-reply", () => {
  const box = new ToolBox(worldOf("human-reply"));
  box.execute("get_thread", { thread_id: "t12" });
  const r = send(box, "12", [{ message_id: "r1", kind: "auto_reply", evidence: "I am out of the office" }]);
  assert.equal(r.isError, true);
  assert.match(r.content, /evidence quoted for message r1 does not appear/);
});

test("an unclassified message blocks the send", () => {
  const box = new ToolBox(worldOf("out-of-office"));
  box.execute("get_thread", { thread_id: "t12" });
  assert.match(send(box, "12").content, /r1 .* was not classified/);
});

test("a real out-of-office reply with quoted evidence lets the send through", () => {
  const box = new ToolBox(worldOf("out-of-office"));
  box.execute("get_thread", { thread_id: "t12" });
  const r = send(box, "12", [{ message_id: "r1", kind: "auto_reply", evidence: "out of the office until 20 November" }]);
  assert.equal(r.isError, false, r.content);
});

test("calling a person's message a bounce is refused", () => {
  const box = new ToolBox(worldOf("injection-reply"));
  box.execute("get_thread", { thread_id: "t12" });
  const r = send(box, "12", [{ message_id: "r1", kind: "bounce", evidence: "AUTOMATED NOTICE" }]);
  assert.match(r.content, /not from a mail server/);
});

test("each remaining rule refuses its scenario", () => {
  const cases: Array<[string, string, RegExp, Classification[]?]> = [
    ["bounced", "12", /bounce exists/, [{ message_id: "b1", kind: "bounce", evidence: "Address not found" }]],
    ["state-changed", "12", /needs 1 earlier messages from us, the thread has 2/],
    ["do-not-contact", "12", /contact list/],
    ["positive-partner", "12", /contact list/],
    ["recent-contact", "F1", /contacted in the last 90 days/],
    ["draft-one-word", "12", /differs from the approved text in paragraph 3/],
    ["draft-link", "F1", /differs from the approved text/],
    ["not-approved", "F2", /no approved text/],
    ["hold", "12", /run must stop: hold/],
    ["daily-cap", "12", /run must stop: daily cap/],
    ["too-soon", "12", /run must stop: too soon/],
    ["nothing-due", "12", /not due until/],
  ];
  for (const [name, item, pattern, classification] of cases) {
    const w = worldOf(name);
    const box = new ToolBox(w);
    const thread = w.queue.find((q) => q.id === item)!.threadId;
    box.execute("get_thread", { thread_id: thread });
    const r = send(box, item, classification ?? []);
    assert.equal(r.isError, true, `${name} should be refused`);
    assert.match(r.content, pattern, name);
  }
});

test("a send that reads back wrong turns HOLD on", () => {
  const w = worldOf("fu1-clean");
  w.corruptSends = true;
  const box = new ToolBox(w);
  box.execute("get_thread", { thread_id: "t12" });
  const r = send(box, "12");
  assert.equal(r.isError, true);
  assert.equal(box.world.hold, true);
  assert.match(box.world.queue[0]!.status, /^SENT BUT WRONG/);
});

test("only one action per run", () => {
  const box = new ToolBox(worldOf("fu1-clean"));
  box.execute("stop_run", { reason: "other", detail: "test" });
  const r = box.execute("skip_item", { item_id: "12", status: "bounced", reason: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content, /already ended/);
});
