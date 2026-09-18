import { describe, expect, it } from "vitest";
import { planBatches } from "../src/run.js";
import { parseInline } from "../src/questions.js";
import type { Unit } from "../src/types.js";

const units: Unit[] = [
  { id: "a.ts#file", path: "a.ts", source: "const a = 1;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
  { id: "b.ts#file", path: "b.ts", source: "const b = 2;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
];

describe("parseInline", () => {
  it("builds typed questions and binds choices and levels by id", () => {
    const questions = parseInline({
      booleans: ["leak=Does this leak?"],
      choices: ["owner=Who owns this?"],
      choicesFor: ["owner=auth,billing"],
      scores: ["read=How readable?"],
      levelsFor: ["read=opaque,clear"],
    });
    expect(questions.map((question) => `${question.id}:${question.kind}`)).toEqual([
      "leak:boolean",
      "owner:choice",
      "read:score",
    ]);
  });

  it("rejects a choice without matching --choices", () => {
    expect(() =>
      parseInline({ booleans: [], choices: ["owner=Who?"], choicesFor: [], scores: [], levelsFor: [] }),
    ).toThrow("--choices");
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseInline({ booleans: ["q=One?", "q=Two?"], choices: [], choicesFor: [], scores: [], levelsFor: [] }),
    ).toThrow("duplicate question id");
  });
});

describe("planBatches", () => {
  it("keeps small workloads in one batch", () => {
    const questions = parseInline({
      booleans: ["leak=Does this leak?"],
      choices: [],
      choicesFor: [],
      scores: [],
      levelsFor: [],
    });
    const batches = planBatches(units, questions);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });
});
