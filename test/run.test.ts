import { describe, expect, it } from "vitest";
import { ask, shardItems, STATE_BUDGET_CHARS, summarize } from "../src/run.js";
import { parseInline } from "../src/questions.js";
import { reachableFiles, splitCustom } from "../src/splitter.js";
import type { Unit } from "../src/types.js";

const units: Unit[] = [
  { id: "a.ts#file", path: "a.ts", source: "const a = 1;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
  { id: "b.ts#file", path: "b.ts", source: "const b = 2;\n", span: { start: 0, end: 12, startLine: 1, endLine: 1 } },
];

function questions() {
  return parseInline({
    booleans: ["leak=Does this leak?"],
    choices: [],
    choicesFor: [],
    scores: [],
    levelsFor: [],
  });
}

describe("ask", () => {
  it("answers every unit with a fake evaluator and summarizes", async () => {
    const qs = questions();
    const report = await ask({
      units,
      questions: qs,
      evaluator: {
        ask: async (_state, payload) => ({
          answers: Object.fromEntries(
            Object.keys(payload).map((key) => [key, { type: "noul", noul: 0.8 }]),
          ),
          usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
        }),
      },
    });
    expect(report.coverage.complete).toBe(true);
    expect(report.coverage.questionsAsked).toBe(2);
    expect(report.units[0]?.answers["leak"]).toMatchObject({ type: "boolean", probability: 0.8 });
    expect(report.summary["leak"]).toMatchObject({ type: "boolean", n: 2, yes: 2 });
    expect(report.usage.totalTokens).toBeGreaterThan(0);
  });

  it("records unanswered when the evaluator omits answers", async () => {
    const qs = questions();
    const report = await ask({
      units,
      questions: qs,
      evaluator: {
        ask: async () => ({
          answers: {},
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        }),
      },
    });
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.unanswered).toHaveLength(2);
  });

  it("dry-run asks nothing and stays complete", async () => {
    const report = await ask({ units, questions: questions(), dryRun: true });
    expect(report.coverage.questionsAsked).toBe(0);
    expect(report.coverage.unitsAsked).toBe(0);
    expect(report.coverage.complete).toBe(true);
  });
});

describe("shardItems", () => {
  const big = (id: string, size: number): Unit => ({
    id,
    path: `${id}.ts`,
    source: "x".repeat(size),
    span: { start: 0, end: size, startLine: 1, endLine: 1 },
  });

  it("keeps small scopes in one shard", () => {
    const qs = questions();
    const shards = shardItems(units, [
      { key: "a", unitIndex: 0, resultIndex: 0, questionId: "leak", question: qs[0]! },
    ]);
    expect(shards).toHaveLength(1);
    expect(shards[0]?.units).toHaveLength(1);
  });

  it("splits sources that exceed the budget and remaps indices", () => {
    const qs = questions();
    const bigUnits = [big("a", 20_000), big("b", 20_000), big("c", 20_000)];
    const pending = bigUnits.flatMap((_, i) =>
      qs.map((question) => ({
        key: `leak__${i}`,
        unitIndex: i,
        resultIndex: i,
        questionId: question.id,
        question,
      })),
    );
    const shards = shardItems(bigUnits, pending, 30_000);
    expect(shards.length).toBeGreaterThan(1);
    // every item still resolves to its global unit, with a local inspect index
    for (const shard of shards) {
      for (const item of shard.items) {
        expect(shard.units[item.unitIndex]?.id).toBe(bigUnits[item.resultIndex]?.id);
      }
    }
    expect(shards.flatMap((s) => s.items)).toHaveLength(pending.length);
  });

  it("asks large scopes with bounded per-request state", async () => {
    const qs = questions();
    const bigUnits = [
      big("a", 20_000),
      big("b", 20_000),
      big("c", 20_000),
    ];
    const stateSizes: number[] = [];
    let calls = 0;
    const report = await ask({
      units: bigUnits,
      questions: qs,
      evaluator: {
        ask: async (state, payload) => {
          calls += 1;
          stateSizes.push(JSON.stringify(state).length);
          return {
            answers: Object.fromEntries(
              Object.keys(payload).map((key) => [key, { type: "noul", noul: 0.5 }]),
            ),
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          };
        },
      },
    });
    expect(report.coverage.complete).toBe(true);
    expect(calls).toBeGreaterThan(1);
    for (const size of stateSizes) {
      expect(size).toBeLessThan(STATE_BUDGET_CHARS + 8_192);
    }
  });
});
describe("summarize", () => {
  it("aggregates score means and lowest ids", async () => {
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
            Object.keys(payload).map((key, i) => [key, { type: "score", score: i + 1 }]),
          ),
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        }),
      },
    });
    expect(report.summary["read"]).toMatchObject({ type: "score", n: 2, mean: 1.5 });
    const entry = report.summary["read"];
    expect(entry.type === "score" && entry.lowest[0]).toBe("a.ts#file");
    // direct summarize path stays consistent
    expect(Object.keys(summarize(units, new Map(), qs))).toEqual(["read"]);
  });
});

describe("splitCustom", () => {
  it("defaults path for single-file finds", async () => {
    const out = await splitCustom(
      [{ path: "a.ts", source: "const x = 1;\n" }],
      () => [{ span: { start: 0, end: 5 } }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("a.ts");
    expect(out[0]?.source).toBe("const");
  });

  it("rejects pathless units when splitting multiple files", async () => {
    await expect(
      splitCustom(
        [
          { path: "a.ts", source: "const a = 1;\n" },
          { path: "b.ts", source: "const b = 2;\n" },
        ],
        () => [{ source: "orphan" }],
      ),
    ).rejects.toThrow("no path");
  });
});

describe("reachableFiles", () => {
  const files = [
    { path: "src/index.ts", source: "import { db } from './db.js';\n" },
    { path: "src/db.ts", source: "export const db = 1;\n" },
  ];

  it("accepts a ./ -prefixed entry", () => {
    expect(reachableFiles(files, "./src/index.ts", 1).map((f) => f.path)).toEqual([
      "src/db.ts",
      "src/index.ts",
    ]);
  });
});
