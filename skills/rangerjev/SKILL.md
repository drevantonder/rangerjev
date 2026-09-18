---
name: rangerjev
description: "Use rangerjev when needing to quickly ask boolean, choice, or scored questions of a codebase."
---

# RangerJev

Ask typed questions of a codebase. It never generates prose and never
decides pass/fail. It reports probabilities that agents and humans compose.

## Prerequisites

- `rangerjev` on `PATH` (installed globally; `rangerjev --help` is the flag reference).
- `TYPESAFE_API_KEY` in the environment for live runs (see the README's
  Install section). Dry runs need no key.

## Process

1. Pick the scope: paths plus a splitter — `--by file` (default), `--by
   function`, or `--by call-tree --entry <root> --depth <n>`. Cap runaway
   scopes with `--max-units <n>`.
2. Pick the questions: inline `--boolean id=text`, `--choice id=text` with
   `--choices id=a,b,..`, `--score id=text` with `--levels id=low,..,high` —
   or `--questions q.json` when criteria need prose. Keep ids short; they key
   the answers. Prefer one combined run over per-question runs — batching
   shares state and the cache dedupes repeats.
3. Dry-run first (zero live requests, verifies the scope):
   `rangerjev <paths> --by <kind> <questions> --dry-run`. Stdout is always
   JSON, so point it at a file.
4. Run live with JSON redirected to a file (`> report.json`) and stderr
   separate. Large scopes shard automatically; no manual sharding needed.
5. Read the report: `units[].answers` per unit, `summary` for aggregates
   (score means plus the 5 `lowest` ids — start triage there), `escalations`
   when `--escalate-below` is set (low-confidence review list, worst first),
   and `coverage.complete` (exit 0 = every unit answered, 1 = something
   unanswered — check `coverage.unanswered`).

## Reference

- Question types: `boolean` (P(yes); `summary.yes` counts P ≥ 0.5), `choice`
  (winning label plus per-option probabilities), `score` (expected position
  on your ordered levels, low to high). Boolean answers carry no
  confidence, so `--escalate-below` only ever lists choice/score answers.
- `--context <file>` includes extra text once in every request state.
- `--tests-only` / `--changed [--base <ref>]` narrow the scope to test
  files or git-changed files; they compose with every `--by` splitter.
- Custom splitters: `--unit-finder <module>` (one file, default export;
  see the README's "Custom splitters" section, `rangerjev/oxc` re-exports
  the pinned parser). Prefer the `oxc` Visitor over regex.
- `--ext <.a,.b>` adds file extensions beyond JS/TS.
- Chatter, dry-run counts, and failure notes go to stderr; stdout carries
  only the report. Invalid input, provider failure, or unanswered questions
  exit 1.
