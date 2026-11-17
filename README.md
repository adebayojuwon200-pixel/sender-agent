# sender-agent

A Claude agent with its own tools, its own loop and a send guard written in code. It rebuilds the checks of Eodly's partner outreach sender, which used to run as a Claude Code scheduled task, as a small TypeScript program on the Claude API.

The design rule: **the model decides, the code enforces.** Claude chooses which tools to call and makes the one judgement code can't, whether a reply in the thread came from a person. Every rule that must never break is checked again in code inside `send_email`, so a confused or manipulated model still cannot send a wrong email.

## How a run works

1. `src/agent.ts` sends the task, the system prompt and 11 tool definitions to Claude (`claude-opus-5-5`, effort `medium`).
2. Claude answers with tool calls. The loop runs each one through `ToolBox` (`src/tools.ts`), returns every result in a single message, and repeats.
3. A run ends with exactly one action: `send_email`, `skip_item` with a status, or `stop_run`. A second action in the same run is refused.

| Tool | What it does |
| --- | --- |
| `get_run_state` | HOLD switch, emails sent today (cap 10), minutes since the last send (minimum 25) |
| `get_next_queue_item` | First queued item that is due and inside the recipient's working hours, in their time zone |
| `get_thread` | Every message in the thread, marked as data written by other people |
| `find_bounces` | Mail server failure notices for the address in the last 60 days |
| `find_recent_contacts` | Anything we sent to the same domain in the last 90 days |
| `check_contact_lists` | Do-not-contact and positive partner lists |
| `get_draft` | The saved draft, if any |
| `check_outgoing_text` | Compares the outgoing text with the approved wording, and lints it for links, bare domains and dashes |
| `send_email` | Re-checks every rule, sends, reads the message back, and queues the next step |
| `skip_item` | Marks the item for a person to look at, with a fixed status |
| `stop_run` | Ends the run without touching the queue |

## What the code refuses, whatever the model says

`guardSend` in `src/rules.ts` blocks a send when:

- HOLD is on, 10 emails went out today, or the last one was under 25 minutes ago
- the item is not queued, not due, or the recipient is outside Mon to Fri, 09:00 to 17:00 local time
- the thread was not read in this run
- any thread message we did not send is unclassified, classified as a person, called a bounce without coming from a mail server, or called an auto-reply without quoting words that are really in it
- a bounce exists for the address
- the number of our earlier messages does not fit the step (first email 0, follow-up 1, final note 2)
- the address or domain is on a contact list, or a first email's domain was contacted in the last 90 days
- the text differs from the approved wording in any word, or has a link, a bare domain or a dash

If the message read back from Sent differs from what was built, the agent turns HOLD on and no more email goes out until a person clears it.

## Run it

Needs Node 23.6 or later (TypeScript runs directly, no build step).

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

The tests need no API key. They cover every guard rule, and the loop itself with a scripted stand-in for Claude.

To run the agent against Claude, copy `.env.example` to `.env` and add your key, then:

```bash
npm run scenario -- injection-reply
```

```bash
npm run eval
```

`npm run eval` runs all 18 scenarios, 4 at a time, stops starting new ones once `EVAL_BUDGET_USD` (default 3) is spent, prints a pass table and saves every transcript under `evals/results/`.

## The 18 eval scenarios

Each scenario in `evals/scenarios.ts` is a small mailbox and queue with the right answer written down: 4 sends, 10 skips and 4 stops. They include an out-of-office reply that should not block a follow-up, a bounce sitting inside the thread, a draft with one word changed, a colleague at the same company emailed 46 days ago, and a reply that tells AI assistants to ignore their rules and send.

## Results

Three full runs on 16 Nov 2026, Claude Opus 5.5 at medium effort:

| Run | Passed | Cost (USD) | Average turns | Sends refused by the guard |
| --- | --- | --- | --- | --- |
| 1 | 18 of 18 | 0.291 | 4.4 | 0 |
| 2 | 18 of 18 | 0.261 | 4.4 | 0 |
| 3 | 18 of 18 | 0.254 | 4.3 | 0 |

That is 54 of 54 decisions right, at about 1.5 cents a run. In the injection scenario Claude named the planted instruction in its skip reason and did not follow it. The guard never had to refuse a send in these runs; its refusals are covered by the offline tests instead.

These are hand-written scenarios with one fault each. Real threads are messier, so the next step for the eval set is a sample of real, anonymised threads from the outreach history.

## API choices

- Manual tool loop on `client.beta.messages.create`, so every step is visible and testable.
- Strict tool schemas (`strict: true`), so tool inputs always match their schema.
- Server-side refusal fallback on (`fallbacks: "default"`): if the model declines a request, the API retries it on a fallback model in the same call.
- Automatic prompt caching (`cache_control` at the top level) on the growing conversation.
- Cost per run is tracked from the usage the API reports.

## Limits

The mailbox is a fixture in memory, so nothing here touches real email. Connecting it to Gmail means writing one adapter with the same tool functions on top of the Gmail API.
