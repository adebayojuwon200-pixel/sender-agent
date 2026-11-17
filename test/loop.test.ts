import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../src/agent.ts";
import { SCENARIOS } from "../evals/scenarios.ts";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** A stand-in for the Claude API that replays a fixed script and records every request it receives. */
function scriptedClient(script: Block[][]) {
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(structuredClone(params));
          const content = script[i++] ?? [{ type: "text", text: "done" }];
          return {
            id: `msg_${i}`,
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content,
            stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            stop_details: null,
            usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const use = (id: string, name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id, name, input });
const world = (name: string) => structuredClone(SCENARIOS.find((s) => s.name === name)!.world);

test("the loop runs tools, returns every result in one message, and records the outcome", async () => {
  const { client, requests } = scriptedClient([
    [use("a", "get_run_state")],
    [use("b", "get_next_queue_item"), use("c", "get_thread", { thread_id: "t12" })],
    [use("d", "send_email", { item_id: "12", thread_classification: [] })],
    [{ type: "text", text: "Sent follow-up 1 to Northwind." }],
  ]);
  const r = await runAgent(world("fu1-clean"), { client });

  assert.deepEqual(r.outcome.action, "sent");
  assert.equal(r.turns, 4);
  assert.equal(r.finalText, "Sent follow-up 1 to Northwind.");
  assert.equal(r.toolCalls.length, 4);

  const first = requests[0]!;
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.output_config, { effort: "medium" });
  assert.equal((first.tools as unknown[]).length, 11);

  const third = requests[2]!.messages as Anthropic.Beta.BetaMessageParam[];
  const results = third.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.deepEqual(results.map((b) => b.tool_use_id), ["b", "c"], "both parallel results in one user message");
  assert.equal(r.usage.input, 4000);
  assert.ok(r.costUsd > 0);
});

test("a refused send is reported back to the model, which can then skip", async () => {
  const { client } = scriptedClient([
    [use("a", "get_thread", { thread_id: "t12" })],
    [use("b", "send_email", { item_id: "12", thread_classification: [{ message_id: "r1", kind: "human", evidence: "Thanks Sam" }] })],
    [use("c", "skip_item", { item_id: "12", status: "replied: hand to Sam", reason: "Ada replied on 12 Nov." })],
    [{ type: "text", text: "Skipped: Ada replied." }],
  ]);
  const r = await runAgent(world("human-reply"), { client });

  const refused = r.toolCalls.find((c) => c.name === "send_email")!;
  assert.equal(refused.isError, true);
  assert.match(refused.result, /reply from a person/);
  assert.deepEqual(r.outcome, { action: "skipped", item: "12", status: "replied: hand to Sam", reason: "Ada replied on 12 Nov." });
});

test("a run that never sends, skips or stops is reported as no outcome", async () => {
  const { client } = scriptedClient([[{ type: "text", text: "I am not sure what to do." }]]);
  const r = await runAgent(world("fu1-clean"), { client });
  assert.equal(r.outcome.action, "none");
});

test("the loop stops at the turn limit", async () => {
  const { client } = scriptedClient(Array.from({ length: 20 }, (_, i) => [use(`x${i}`, "get_run_state")]));
  const r = await runAgent(world("fu1-clean"), { client, maxTurns: 5 });
  assert.equal(r.turns, 5);
  assert.equal(r.outcome.action, "none");
});
