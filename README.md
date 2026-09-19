# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

> **This is a fork** of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
> The only change is the section below: Jev can also be reached through **Vercel
> AI Gateway**, so the plugin works without an invite-only TypeSafe account. That
> is how this fork runs today. Add a TypeSafe key once you have one and it takes
> over automatically, with no reinstall; see
> [Switching to TypeSafe direct](#switching-to-typesafe-direct). Everything else
> is upstream's.


## Vercel AI Gateway (this fork)

Upstream reaches Jev at `api.typesafe.ai`, which needs a TypeSafe account.
TypeSafe is invite-only at the time of writing, so this fork can send the same
Jev requests through
[Vercel AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway),
where the same model is published as `typesafe-ai/jev`. Nothing else changes:
the scoring, the pruning and the fallback are upstream's.

**Which provider is in use** is decided by which key is found, in this order.
The first hit wins:

| # | Source | Provider |
| - | ------ | -------- |
| 1 | `apiKey` plugin option | TypeSafe direct |
| 2 | `TYPESAFE_API_KEY` (process env, or settings `env`) | TypeSafe direct |
| 3 | `~/.config/typesafe/key` | TypeSafe direct |
| 4 | `AI_GATEWAY_API_KEY` (process env, or settings `env`) | Vercel AI Gateway |
| 5 | `~/.config/jev-gateway/key` | Vercel AI Gateway |

A TypeSafe key always wins over a gateway key, so you can leave a gateway key in
place and switch to direct access later by adding a TypeSafe key (see
[Switching to TypeSafe direct](#switching-to-typesafe-direct)).

### Requirements

- Claude Code **2.1.274 or newer** (function hooks; `claude --version`)
- Node.js 18 or newer
- A Vercel account with AI Gateway enabled, **or** a TypeSafe API key

### Install with a Vercel AI Gateway key

**1. Create a gateway API key.** From the AI Gateway section of the Vercel
dashboard, under API Keys, or with the CLI (a budget is optional but
recommended):

```sh
npm i -g vercel@latest
vercel login
vercel ai-gateway api-keys create --name jev-mcp --limit 10 --refresh-period monthly
```

AI Gateway requires a verified card on the team before it serves requests, even
when free credits cover the usage.

**2. Save the key** where the plugin looks for it:

```sh
mkdir -p ~/.config/jev-gateway
printf '%s' "vck_your_key_here" > ~/.config/jev-gateway/key
chmod 600 ~/.config/jev-gateway/key
```

`AI_GATEWAY_API_KEY` in the environment or in the settings `env` block works
just as well; the file avoids exporting a secret into every shell.

**3. Enable function hooks** in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

**4. Install the plugin** from a local clone:

```sh
git clone -b gateway-support https://github.com/rampshade-cloud/fast-jev-compaction.git
claude plugin marketplace add "$PWD/fast-jev-compaction"
claude plugin install fast-jev-compaction@fast-jev-compaction
```

Restart Claude Code, or run `/reload-plugins`.

Editing the clone does not change the installed plugin: the install is a copy
under `~/.claude/plugins/cache/`. After a local edit, refresh it with

```sh
claude plugin marketplace update fast-jev-compaction
claude plugin uninstall fast-jev-compaction@fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

### Verifying

Run `/compact` in a session that has a few tool calls behind it. A toast reports
the outcome:

- `kept N/M messages, no summary (…)` — Jev's decisions replaced the built-in
  summary.
- `fallback to built-in summary (…)` — the reason is in the parentheses; Claude
  Code's own summary was used instead. Short sessions fall back by design, since
  the reduction stays under `minReductionRatio`.

`claude --debug-file /tmp/cc.log` records the per-call decisions, the endpoint
and the request time:

```
$.http.fetch (fast-jev-compaction): POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
$.http.fetch (fast-jev-compaction): 200 in 735ms
[fast-jev-compaction] decisions: t1:Bash:drop_call/call=0.14/result=0.09 …
[fast-jev-compaction] kept 14/24 messages, no summary (88% reduction; …)
```

Verified on Claude Code 2.1.276: a manual `/compact` of a 24-message transcript
sent one gateway request (735 ms) and the hook answered `session.compact` with
14 messages and an 88% character reduction, with no summary generated. The unit
tests for the gateway request and response translation are in
`tests/gateway.test.ts` and make no network calls.

### Configuration

Every upstream option applies unchanged. Set them interactively with
`/plugin configure fast-jev-compaction@fast-jev-compaction`, or on install with
`--config KEY=VALUE`:

| Option | Default | Meaning |
| ------ | ------: | ------- |
| `keepThreshold` | `0.5` | Minimum Jev probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched |
| `compactAtPercent` | `60` | Context percentage at which the plugin asks for compaction |
| `minReductionRatio` | `0.25` | Below this reduction, fall back to the built-in summary |
| `maxStateTokens` | `25000` | Token budget for the state sent to Jev |
| `maxRequestTokens` | `30000` | Token budget for state plus questions in one request |
| `truncateHeadChars` | `300` | Characters kept from a dropped tool result |
| `model` | `jev-latest` | Jev model name |
| `apiKey` | unset | TypeSafe key; overrides every other source |

`compactAtPercent` defaults to 60, which is earlier than Claude Code's own
auto-compaction. Raise it if compaction starts sooner than you want.

`model` takes a TypeSafe model name. On the gateway, a bare name is mapped onto
its gateway id: `jev-latest` and `jev` both become `typesafe-ai/jev`, and a name
that already contains a slash is passed through unchanged.

### Switching to TypeSafe direct

Nothing needs to be reinstalled or reconfigured when a TypeSafe account becomes
available. Write the key where the plugin looks first:

```sh
mkdir -p ~/.config/typesafe
printf '%s' "ts_your_key_here" > ~/.config/typesafe/key
chmod 600 ~/.config/typesafe/key
```

The next compaction goes to `https://api.typesafe.ai/v1/systemone` with the
model name as given (`jev-latest` by default), exactly as upstream does. The
gateway key can stay where it is; it is only consulted when no TypeSafe key is
found. To go back to the gateway, remove the TypeSafe key (and
`TYPESAFE_API_KEY`, if it is set).

At that point this fork has no behavioural difference from upstream, so
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
can be installed instead.

### 計測ツール / Measuring what compaction keeps

`tools/` holds the scripts used to compare this fork's Jev pruning against
Claude Code's built-in summary on real transcripts, plus the aggregate stats
behind the numbers quoted there. They are development tools and never run
during a session. See [tools/README.md](tools/README.md).

### Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| No toast at all on `/compact` | Function hooks are off, or Claude Code is older than 2.1.274. Check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` and `claude --version`. |
| `fallback to built-in summary (no Jev key: …)` | No key was found in any of the five sources above. |
| `fallback to built-in summary (… requires a valid credit card …)` | The Vercel team has no verified card; AI Gateway refuses requests until one is added. |
| `fallback to built-in summary (below 25% minimum: …)` | Working as intended: too little to remove. Lower `minReductionRatio` to allow smaller wins. |
| Edits to the clone have no effect | The installed copy lives in `~/.claude/plugins/cache/`; refresh it with the marketplace update and reinstall above. |

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
