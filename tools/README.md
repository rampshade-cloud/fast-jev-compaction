# tools — measuring what compaction actually keeps

Scripts used to answer a question the plugin's README cannot: **does Jev keep
more of what the session later needs than the built-in summary does?**

They are development tools, not part of the plugin. Nothing here runs during a
session.

## Why these exist

A compaction is only good if the work can continue afterwards. Reduction
percentage does not measure that, and neither does speed. What matters is
whether the things the session reaches for *after* the compaction are still
there.

Claude Code makes that measurable by accident: a transcript keeps every message
from before a compaction, records the boundary, and stores the summary the
built-in compaction produced. So the past is ground truth for its own future.

## The scripts

### `compaction-stats.py` — what really happened

Aggregates every `compact_boundary` in `~/.claude/projects`: who compacted
(Jev finishes in under a second, the built-in summary takes about two minutes),
tokens before and after, and a re-read rate — how often the tools called right
after a compaction touch something touched before it.

```sh
python3 tools/compaction-stats.py
python3 tools/compaction-stats.py --since 2026-09-19 --detail
```

No API calls, no cost. Run it before and after a settings change and compare.

### `compare-summary.ts` — Jev against the real summary

The main tool. For each real compaction it takes the 150 messages before the
boundary, runs them through the library, and compares what survives against the
summary Claude Code actually wrote at that moment. Ground truth is every file
path that appears both before the boundary and in the 60 messages after it.

Two measures, applied identically to both:

- **mention** — the path still appears in the post-compaction context
- **verbatim** — the specific line that referenced it survives character for
  character (a summary paraphrases, so this is where the two differ)

```sh
npx tsx tools/compare-summary.ts --files 8 --per-file 3
```

### `score-jev.ts` — thresholds, and picking usable transcripts

Replays a transcript at several `keepThreshold` values. `--scan` finds
transcripts with enough ground truth to be worth scoring, and makes no API
calls:

```sh
npx tsx tools/score-jev.ts --scan --files 15
npx tsx tools/score-jev.ts --transcript <path> --thresholds 0.3,0.5,0.7
```

## What the measurements showed

13 real compactions, 192 needed files, one developer's logs:

| | built-in summary | Jev |
| --- | ---: | ---: |
| mention retained | 51% | 48% |
| verbatim retained | 9% | 42% |
| duration (median of 160 compactions) | 127.7 s | 0.7 s |
| surviving context | 1.0x | 1.7x |

Jev won verbatim retention in 12 of 13 and never lost it; the summary held a
slight edge on mentions while keeping 1.7x less context. `keepThreshold` made
no difference at all — every one of 46 candidate calls scored below 0.3, so
0.3 and 0.7 dropped exactly the same set.

Read that as a trade, not a verdict: Jev is fast and exact about what it keeps,
and it does not save context.

## Limits worth stating

- One developer's logs, 13 compactions. Treat the numbers as a direction.
- "Needed later" is a file path reappearing — a proxy. It cannot see a need a
  human would recognise from the wording alone.
- The session continued with the *summary* in context, so a path the summary
  lost was re-read and counted as needed, while one it kept may never reappear.
  Ground truth therefore leans toward the summary's failures.
- The summary was written from the whole conversation; Jev saw 150 messages.
- The free tier rate-limits Jev on Vercel AI Gateway. It clears in about 31
  seconds, so requests are serialised with `--interval` (35s by default).
