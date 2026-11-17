import { mkdirSync, writeFileSync } from "node:fs";
import { runAgent, type RunResult } from "../src/agent.ts";
import type { Expectation, Outcome, Scenario } from "../src/types.ts";
import { SCENARIOS } from "./scenarios.ts";

const budget = Number(process.env.EVAL_BUDGET_USD ?? "3");
const concurrency = Number(process.env.EVAL_CONCURRENCY ?? "4");
const only = process.argv.slice(2);
const chosen = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;

function passes(expect: Expectation, got: Outcome): boolean {
  if (expect.action !== got.action) return false;
  if (expect.action === "stopped" && got.action === "stopped") return expect.reason === got.reason;
  if (expect.action === "sent" && got.action === "sent") return expect.item === got.item;
  if (expect.action === "skipped" && got.action === "skipped") return expect.item === got.item && expect.status === got.status;
  return false;
}

const describe = (o: Expectation | Outcome): string =>
  o.action === "sent" ? `sent ${o.item}` : o.action === "skipped" ? `skipped ${o.item}: ${o.status}` : o.action === "stopped" ? `stopped: ${o.reason}` : `none`;

interface Row {
  name: string;
  expected: string;
  got: string;
  pass: boolean;
  turns: number;
  toolCalls: number;
  refusedSends: number;
  costUsd: number;
  error?: string;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `evals/results/${stamp}`;
mkdirSync(outDir, { recursive: true });

let spent = 0;
const rows: Row[] = [];
const queue = [...chosen];

async function worker() {
  for (let s = queue.shift(); s; s = queue.shift()) {
    if (spent >= budget) {
      rows.push({ name: s.name, expected: describe(s.expect), got: "not run (budget reached)", pass: false, turns: 0, toolCalls: 0, refusedSends: 0, costUsd: 0 });
      continue;
    }
    rows.push(await runOne(s));
  }
}

async function runOne(s: Scenario): Promise<Row> {
  try {
    const r: RunResult = await runAgent(structuredClone(s.world));
    spent += r.costUsd;
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify({ scenario: s.name, expect: s.expect, ...r }, null, 2));
    return {
      name: s.name,
      expected: describe(s.expect),
      got: describe(r.outcome),
      pass: passes(s.expect, r.outcome),
      turns: r.turns,
      toolCalls: r.toolCalls.length,
      refusedSends: r.toolCalls.filter((c) => c.name === "send_email" && c.isError).length,
      costUsd: r.costUsd,
    };
  } catch (err) {
    return { name: s.name, expected: describe(s.expect), got: "error", pass: false, turns: 0, toolCalls: 0, refusedSends: 0, costUsd: 0, error: String(err) };
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, chosen.length) }, worker));
rows.sort((a, b) => chosen.findIndex((s) => s.name === a.name) - chosen.findIndex((s) => s.name === b.name));

const passed = rows.filter((r) => r.pass).length;
const lines = [
  `| Scenario | Expected | Got | Pass | Turns | Tool calls | Refused sends | Cost (USD) |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...rows.map((r) => `| ${r.name} | ${r.expected} | ${r.got}${r.error ? ` (${r.error.slice(0, 80)})` : ""} | ${r.pass ? "yes" : "NO"} | ${r.turns} | ${r.toolCalls} | ${r.refusedSends} | ${r.costUsd.toFixed(4)} |`),
  ``,
  `Passed ${passed} of ${rows.length}. Spent $${spent.toFixed(3)} (budget $${budget}). Model ${process.env.AGENT_MODEL ?? "claude-opus-5-5"}, effort ${process.env.AGENT_EFFORT ?? "medium"}.`,
];
writeFileSync(`${outDir}/summary.md`, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nTranscripts and summary: ${outDir}`);
process.exitCode = passed === rows.length ? 0 : 1;
