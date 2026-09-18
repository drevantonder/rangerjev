import { describe, expect, it } from "vitest";
import { ask } from "../src/run.js";
import { parseInline } from "../src/questions.js";
import type { Unit } from "../src/types.js";

const units: Unit[] = [
  { id: "a.ts#file", path: "a.ts", source: "const a = 1;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
  { id: "b.ts#file", path: "b.ts", source: "const b = 2;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
];

describe("escalations", () => {
  it("lists choice/score answers below the threshold, worst first", async () => {
    const qs = parseInline({
      booleans: ["leak=Does this leak?"],
      choices: [],
      choicesFor: [],
      scores: ["read=How readable?"],
      levelsFor: ["read=opaque,clear"],
    });
    const report = await ask({
      units,
      questions: qs,
      escalateBelow: 0.6,
      evaluator: {
        ask: async (_state, payload) => ({
          answers: Object.fromEntries(
            Object.keys(payload).map((key) => {
              if (key.startsWith("leak")) return [key, { type: "noul", noul: 0.99 }];
              return [key, { type: "score", score: 1, confidence: key.includes("__0") ? 0.2 : 0.9 }];
            }),
          ),
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        }),
      },
    });
    // boolean answers never escalate (no confidence); only the low score does
    expect(report.escalations).toEqual([
      { unitId: "a.ts#file", questionId: "read", confidence: 0.2 },
    ]);
    expect(report.coverage.complete).toBe(true);
  });

  it("stays empty without a threshold", async () => {
    const qs = parseInline({
      booleans: [],
      choices: [],
      choicesFor: [],
      scores: ["read=How readable?"],
      levelsFor: ["read=opaque,clear"],
    });
    const report = await ask({
      units,
      questions: qs,
      evaluator: {
        ask: async (_state, payload) => ({
          answers: Object.fromEntries(
            Object.keys(payload).map((key) => [key, { type: "score", score: 1, confidence: 0.1 }]),
          ),
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        }),
      },
    });
    expect(report.escalations).toEqual([]);
  });
});
