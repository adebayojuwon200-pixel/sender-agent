import { runAgent } from "./agent.ts";
import { SCENARIOS } from "../evals/scenarios.ts";

const name = process.argv[2];
const scenario = SCENARIOS.find((s) => s.name === name);
if (!scenario) {
  console.log(`Usage: npm run scenario -- <name>\nScenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

console.log(`${scenario.name}: ${scenario.description}\n`);
const result = await runAgent(structuredClone(scenario.world));
for (const call of result.toolCalls) {
  console.log(`${call.isError ? "x" : "-"} ${call.name}(${JSON.stringify(call.input)})`);
  console.log(`    ${call.result.length > 300 ? call.result.slice(0, 300) + "..." : call.result}`);
}
console.log(`\nOutcome: ${JSON.stringify(result.outcome)}`);
console.log(`Agent: ${result.finalText}`);
console.log(`Turns ${result.turns}, cost $${result.costUsd.toFixed(4)}, served by ${result.servedBy.join(", ")}`);
