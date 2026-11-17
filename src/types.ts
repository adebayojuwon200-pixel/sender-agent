export type Step = "FIRST" | "FU1" | "FINAL";
export type Audience = "investor" | "agency";

export interface QueueItem {
  id: string;
  org: string;
  to: string;
  threadId: string;
  greeting: string;
  audience: Audience;
  orgPossessive: string;
  step: Step;
  due: string;
  draftId: string | null;
  tz: string | null;
  status: string;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

export interface Draft {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
}

export interface SendLogEntry {
  when: string;
  item: string;
  result: string;
  messageId?: string;
}

export interface Templates {
  FU1: Record<Audience, string>;
  FINAL: Record<Audience, string>;
  first: Record<string, string>;
}

export interface World {
  now: string;
  us: string;
  hold: boolean;
  queue: QueueItem[];
  threads: Record<string, MailMessage[]>;
  inbox: MailMessage[];
  sentArchive: MailMessage[];
  drafts: Record<string, Draft>;
  sendLog: SendLogEntry[];
  doNotContact: string[];
  positivePartners: string[];
  templates: Templates;
  corruptSends?: boolean;
}

export const SKIP_STATUSES = [
  "replied: hand to Sam",
  "bounced",
  "state changed",
  "on a contact list",
  "already contacted",
  "draft differs, needs Sam",
  "not approved",
] as const;
export type SkipStatus = (typeof SKIP_STATUSES)[number];

export const STOP_REASONS = ["hold", "daily cap", "too soon", "no eligible item", "other"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const MESSAGE_KINDS = ["human", "auto_reply", "bounce"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface Classification {
  message_id: string;
  kind: MessageKind;
  evidence: string;
}

export type Outcome =
  | { action: "sent"; item: string; messageId: string }
  | { action: "skipped"; item: string; status: SkipStatus; reason: string }
  | { action: "stopped"; reason: StopReason; detail: string }
  | { action: "none"; detail: string };

export type Expectation =
  | { action: "sent"; item: string }
  | { action: "skipped"; item: string; status: SkipStatus }
  | { action: "stopped"; reason: StopReason };

export interface Scenario {
  name: string;
  description: string;
  world: World;
  expect: Expectation;
}
