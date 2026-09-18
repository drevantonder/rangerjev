# rangerjev

Ask typed questions of a codebase. Units in, probabilities out.

`rangerjev` splits code into units (files, functions, or a call-tree slice),
asks one Jev judgment per unit, and aggregates the answers in code. It never
generates prose and never decides pass/fail — it reports probabilities that
agents and humans can compose.

## Usage

```sh
# readability survey, one Score per file
rangerjev src/ --by file \
  --score "read=How readable is this code?" \
  --levels "read=opaque,effortful,clear,exemplary"

# yes/no + classification in one request
rangerjev src/ --by function \
  --boolean "leak=Does this leak resources?" \
  --choice "owner=Who owns this?" --choices "owner=auth,billing,infra,none"

# richer criteria live in a file (commas, contrasts, examples)
rangerjev src/ --by file --questions q.json

# follow imports from an entry point, 3 deep
rangerjev --by call-tree --entry src/index.ts --depth 3 --questions q.json

# custom splitter: one file, default export
rangerjev src/ --unit-finder ./effects.ts --questions q.json

# cost preview with zero live requests
rangerjev src/ --by file --questions q.json --dry-run
```

`q.json`:

```json
{
  "read": {
    "type": "score",
    "instructions": "How readable is this code on first read?",
    "criteria": ["Opaque without deep tracing", "Effortful", "Clear", "Exemplary"]
  },
  "leak": {
    "type": "boolean",
    "instructions": "Does this code leak resources (handles, listeners, timers)?"
  }
}
```

Question types are `boolean` (probability of yes), `choice` (one of a closed
set, with per-option probabilities), and `score` (probability-weighted position
on ordered levels). `noul` is accepted as an alias for `boolean`.

## Output

JSON on stdout (default). Human chatter, dry-run counts, and failure notes go
to stderr. Exit `0` means every unit was answered; exit `1` means invalid
input, a provider failure, or at least one unanswered question.

```json
{
  "version": 1,
  "units": [
    {
      "id": "src/db.ts#file",
      "path": "src/db.ts",
      "span": { "start": 0, "end": 812, "startLine": 1, "endLine": 34 },
      "answers": {
        "read": { "type": "score", "score": 1.2, "probabilities": { "0": 0.2, "1": 0.5 } }
      }
    }
  ],
  "summary": {
    "read": { "type": "score", "n": 41, "mean": 2.1, "min": 0.3, "max": 3.0, "lowest": ["src/db.ts#file"] }
  },
  "usage": { "inputTokens": 12000, "outputTokens": 0, "totalTokens": 12000 },
  "coverage": { "unitsEnumerated": 41, "unitsAsked": 41, "questionsAsked": 41, "complete": true }
}
```

`--format text` prints one line per unit plus the summary, for humans.

## Custom splitters

`--unit-finder` loads a module with `jiti`. It must default-export either a
finder function or `{ find }`. Finder input is `{ path, source }` per file plus
parsed-program helpers; output is `{ id, path, source, span? }` per unit.
`oxc-parser` (`Visitor`, `parseSync`, node types) is re-exported from
`rangerjev/oxc` so splitters pin the same parser version as the CLI.

```ts
import { defineUnitFinder } from "rangerjev";
import { Visitor } from "rangerjev/oxc";

export default defineUnitFinder("effects", (file, { program }) => {
  const units = [];
  new Visitor({
    CallExpression(n) {
      if (n.callee.type === "Identifier" && n.callee.name === "effect")
        units.push({ path: file.path, span: { start: n.start, end: n.end } });
    },
  }).visit(program);
  return units;
});
```

## Flags

```text
--by <kind>            file | function | call-tree (default: file)
--entry <path>         call-tree root (required with --by call-tree)
--depth <n>            call-tree import depth (default: 3)
--unit-finder <path>   custom splitter module (overrides --by)
--questions <path>     JSON file of named typed questions
--boolean <id=text>    P(yes) question (repeatable)
--choice <id=text>     categorical question (repeatable)
--choices <id=a,b,..>  options for a choice question (repeatable)
--score <id=text>      ordered-level question (repeatable)
--levels <id=a,b,..>   ordered levels, low to high (repeatable)
--context <path>       extra text file included once in every request state
--ext <.a,.b>          extra file extensions beyond JS/TS (repeatable or comma list)
--max-units <n>        ask only the first n units in path order
--format <f>           json (default) or text
--dry-run              enumerate units and count questions, zero live requests
--help                 show help
```

Auth: `TYPESAFE_API_KEY` in the environment (the same global key jevlint
uses via its SDK fallback). Failing that, the CLI exits 1 before any request.
Model override: `RANGERJEV_MODEL` (default `jev-1.13.0`). Endpoint override:
`TYPESAFE_BASE_URL`.

## Roadmap

- `--by` presets beyond file/function/call-tree (e.g. tests-only, changed-files)
- Response cache (content-addressed, opt-out)
- Confidence-gated escalation lists for low-confidence units
