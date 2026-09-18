import { describe, expect, it } from "vitest";
import { ask } from "../src/run.js";
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

  it("rejects a score with fewer than two levels", () => {
    expect(() =>
      parseInline({
        booleans: [],
        choices: [],
        choicesFor: [],
        scores: ["read=How readable?"],
        levelsFor: ["read=only"],
      }),
    ).toThrow("at least two levels");
  });
});

describe("batching", () => {
  it("answers small workloads in a single live request", async () => {
    const questions = parseInline({
      booleans: ["leak=Does this leak?"],
      choices: [],
      choicesFor: [],
      scores: [],
      levelsFor: [],
    });
    let calls = 0;
    const report = await ask({
      units,
      questions,
      evaluator: {
        ask: async (_state, payload) => {
          calls += 1;
          return {
            answers: Object.fromEntries(
              Object.keys(payload).map((key) => [key, { type: "noul", noul: 0.5 }]),
            ),
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          };
        },
      },
    });
    expect(calls).toBe(1);
    expect(report.coverage.questionsAsked).toBe(2);
    expect(report.coverage.complete).toBe(true);
  });
});
