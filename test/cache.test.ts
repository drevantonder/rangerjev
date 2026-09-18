import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ask } from "../src/run.js";
import { parseInline } from "../src/questions.js";
import {
  cacheKey,
  defaultCacheDir,
  readCachedAnswer,
  writeCachedAnswer,
} from "../src/cache.js";
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

function countingEvaluator(counter: { calls: number }) {
  return {
    ask: async (_state: unknown, payload: Record<string, unknown>) => {
      counter.calls += 1;
      return {
        answers: Object.fromEntries(
          Object.keys(payload).map((key) => [key, { type: "noul", noul: 0.7 }]),
        ),
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
      };
    },
  };
}

describe("cacheKey", () => {
  it("is stable and sensitive to model, source, and question", () => {
    const qs = questions();
    const a = cacheKey("m", "src", qs[0]!);
    expect(cacheKey("m", "src", qs[0]!)).toBe(a);
    expect(cacheKey("other", "src", qs[0]!)).not.toBe(a);
    expect(cacheKey("m", "changed", qs[0]!)).not.toBe(a);
    const other = parseInline({
      booleans: ["other=Different?"],
      choices: [],
      choicesFor: [],
      scores: [],
      levelsFor: [],
    });
    expect(cacheKey("m", "src", other[0]!)).not.toBe(a);
  });
});

describe("defaultCacheDir", () => {
  it("respects XDG_CACHE_HOME", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
      join("/tmp/x", "rangerjev", "v1"),
    );
  });
});

describe("readCachedAnswer", () => {
  it("rejects corrupt or mismatched payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rangerjev-cache-"));
    expect(await readCachedAnswer(dir, "missing", "boolean")).toBeUndefined();
    await writeCachedAnswer(dir, "bad-kind", { type: "score", score: 2 });
    expect(await readCachedAnswer(dir, "bad-kind", "boolean")).toBeUndefined();
    expect(await readCachedAnswer(dir, "bad-kind", "score")).toMatchObject({ score: 2 });
  });
});

describe("ask with cache", () => {
  it("serves repeat runs without live calls and misses on changed source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rangerjev-ask-"));
    const counter = { calls: 0 };
    const run = (inputUnits: Unit[]) =>
      ask({
        units: inputUnits,
        questions: questions(),
        model: "test-model",
        cache: { enabled: true, dir },
        // deno-lint-ignore no-explicit-any
        evaluator: countingEvaluator(counter) as any,
      });

    const first = await run(units);
    expect(counter.calls).toBe(1);
    expect(first.cache).toMatchObject({ enabled: true, hits: 0, misses: 2 });
    expect(first.coverage.complete).toBe(true);

    const second = await run(units);
    expect(counter.calls).toBe(1);
    expect(second.cache).toMatchObject({ enabled: true, hits: 2, misses: 0 });
    expect(second.units).toEqual(first.units);

    const changed: Unit[] = [
      { ...units[0]!, source: "const a = 999;\n" },
      units[1]!,
    ];
    const third = await run(changed);
    expect(counter.calls).toBe(2);
    expect(third.cache).toMatchObject({ enabled: true, hits: 1, misses: 1 });
  });

  it("stays disabled unless requested", async () => {
    const counter = { calls: 0 };
    const report = await ask({
      units,
      questions: questions(),
      // deno-lint-ignore no-explicit-any
      evaluator: countingEvaluator(counter) as any,
    });
    expect(counter.calls).toBe(1);
    expect(report.cache).toMatchObject({ enabled: false, hits: 0 });
  });
});
