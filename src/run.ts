import type { EntryType, JsonValue, Question, Questions } from "@typesafe-ai/sdk";
import type { BatchAnswer, RangerEvaluator } from "./evaluator.js";
import { DEFAULT_MODEL } from "./evaluator.js";
import { cacheKey, defaultCacheDir, readCachedAnswer, writeCachedAnswer } from "./cache.js";
import type {
  Escalation,
  NamedQuestion,
  Report,
  ReportSummary,
  Unanswered,
  Unit,
  UnitAnswer,
  UnitResult,
} from "./types.js";

export const REQUEST_BUDGET_CHARS = 48_000;
export const MAX_QUESTIONS_PER_REQUEST = 24;
const LOWEST_LIMIT = 5;

interface PlannedQuestion {
  key: string;
  /** Index into the current request state (remapped per shard). */
  unitIndex: number;
  /** Stable global unit index for results and cache keys. */
  resultIndex: number;
  questionId: string;
  question: NamedQuestion;
}

export interface AskInput {
  units: Unit[];
  questions: NamedQuestion[];
  context?: string;
  dryRun?: boolean;
  evaluator?: Pick<RangerEvaluator, "ask">;
  /** Model answering (cache key scope). Defaults to the evaluator default. */
  model?: string;
  /** Response cache. Enabled only when set; the CLI enables it by default. */
  cache?: { enabled: boolean; dir?: string };
  /** Report choice/score answers below this confidence as escalations. */
  escalateBelow?: number;
}

function stateFor(units: Unit[], context?: string): { [key: string]: JsonValue } {
  const unitsValue: JsonValue = units.map((unit) => ({
    id: unit.id,
    path: unit.path,
    source: unit.source,
    startLine: unit.span.startLine,
    endLine: unit.span.endLine,
  }));
  const state: { [key: string]: JsonValue } = { units: unitsValue };
  if (context !== undefined) state["context"] = context;
  return state;
}

export function plannedQuestions(units: Unit[], questions: NamedQuestion[]): PlannedQuestion[] {
  const planned: PlannedQuestion[] = [];
  units.forEach((_unit, unitIndex) => {
    for (const question of questions) {
      planned.push({
        key: `${question.id}__${unitIndex}`,
        unitIndex,
        resultIndex: unitIndex,
        questionId: question.id,
        question,
      });
    }
  });
  return planned;
}

function questionPayload(unitIndex: number, question: NamedQuestion): Question {
  const instructions: EntryType = {
    question: question.question.instructions ?? null,
    inspect: `units[${unitIndex}].source`,
  };
  return { ...question.question, instructions };
}

function chunkItems(baseSize: number, items: PlannedQuestion[]): PlannedQuestion[][] {
  const batches: PlannedQuestion[][] = [];
  let current: PlannedQuestion[] = [];
  let currentSize = baseSize;
  for (const item of items) {
    const entrySize = JSON.stringify({
      [item.key]: questionPayload(item.unitIndex, item.question),
    }).length;
    if (
      current.length > 0 &&
      (current.length + 1 > MAX_QUESTIONS_PER_REQUEST ||
        currentSize + entrySize > REQUEST_BUDGET_CHARS)
    ) {
      batches.push(current);
      current = [];
      currentSize = baseSize;
    }
    current.push(item);
    currentSize += entrySize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function planBatches(
  units: Unit[],
  questions: NamedQuestion[],
  context?: string,
): PlannedQuestion[][] {
  const state = stateFor(units, context);
  const baseSize = JSON.stringify(state).length;
  return chunkItems(baseSize, plannedQuestions(units, questions));
}

function isTokenLimit(message: string): boolean {
  return /max[_ -]?tokens|token limit|context length/i.test(message);
}

function checkAnswer(question: NamedQuestion, answer: BatchAnswer | undefined): UnitAnswer | string {
  if (answer === undefined) return "evaluator omitted an answer";
  if (question.kind === "boolean") {
    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
      return `invalid noul answer (${String(answer.noul)})`;
    }
    const out: UnitAnswer = { type: "boolean", probability: answer.noul };
    if (typeof answer.confidence === "number") out.confidence = answer.confidence;
    return out;
  }
  if (question.kind === "choice") {
    if (typeof answer.choice !== "string" || answer.choice === "") {
      return `invalid choice answer (${String(answer.choice)})`;
    }
    const out: UnitAnswer = { type: "choice", choice: answer.choice };
    if (answer.probabilities !== undefined && typeof answer.probabilities === "object") {
      out.probabilities = answer.probabilities as Record<string, number>;
    }
    if (typeof answer.confidence === "number") out.confidence = answer.confidence;
    return out;
  }
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
    return `invalid score answer (${String(answer.score)})`;
  }
  const out: UnitAnswer = { type: "score", score: answer.score };
  if (answer.probabilities !== undefined && typeof answer.probabilities === "object") {
    out.probabilities = answer.probabilities as Record<string, number>;
  }
  if (typeof answer.confidence === "number") out.confidence = answer.confidence;
  return out;
}

interface BatchOutcome {
  answers: { resultIndex: number; questionId: string; answer: UnitAnswer }[];
  unanswered: Unanswered[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function emptyUsage(): BatchOutcome["usage"] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

async function evaluateBatch(
  state: { [key: string]: JsonValue },
  batch: PlannedQuestion[],
  evaluator: Pick<RangerEvaluator, "ask">,
  units: Unit[],
): Promise<BatchOutcome> {
  const payload: Questions = {};
  for (const item of batch) {
    payload[item.key] = questionPayload(item.unitIndex, item.question);
  }
  let result;
  try {
    result = await evaluator.ask(state, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTokenLimit(message) && batch.length > 1) {
      const middle = Math.floor(batch.length / 2);
      const first = await evaluateBatch(state, batch.slice(0, middle), evaluator, units);
      const second = await evaluateBatch(state, batch.slice(middle), evaluator, units);
      return {
        answers: [...first.answers, ...second.answers],
        unanswered: [...first.unanswered, ...second.unanswered],
        usage: {
          inputTokens: first.usage.inputTokens + second.usage.inputTokens,
          outputTokens: first.usage.outputTokens + second.usage.outputTokens,
          totalTokens: first.usage.totalTokens + second.usage.totalTokens,
        },
      };
    }
    return {
      answers: [],
      unanswered: batch.map((item) => ({
        unitId: units[item.resultIndex]?.id ?? `unit_${item.resultIndex}`,
        questionId: item.questionId,
        message: message.replaceAll(/\s+/g, " ").trim().slice(0, 300),
      })),
      usage: emptyUsage(),
    };
  }
  const outcome: BatchOutcome = {
    answers: [],
    unanswered: [],
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
  for (const item of batch) {
    const checked = checkAnswer(item.question, result.answers[item.key]);
    if (typeof checked === "string") {
      outcome.unanswered.push({
        unitId: units[item.resultIndex]?.id ?? `unit_${item.resultIndex}`,
        questionId: item.questionId,
        message: checked,
      });
      continue;
    }
    outcome.answers.push({ resultIndex: item.resultIndex, questionId: item.questionId, answer: checked });
  }
  return outcome;
}

export function summarize(
  units: Unit[],
  results: Map<number, Map<string, UnitAnswer>>,
  questions: NamedQuestion[],
): ReportSummary {
  const summary: ReportSummary = {};
  for (const question of questions) {
    if (question.kind === "boolean") {
      let sum = 0;
      let yes = 0;
      let n = 0;
      results.forEach((byUnit) => {
        const answer = byUnit.get(question.id);
        if (answer?.type === "boolean") {
          n += 1;
          sum += answer.probability;
          if (answer.probability >= 0.5) yes += 1;
        }
      });
      summary[question.id] = { type: "boolean", n, mean: n > 0 ? sum / n : 0, yes };
    } else if (question.kind === "choice") {
      const counts: Record<string, number> = {};
      let n = 0;
      results.forEach((byUnit) => {
        const answer = byUnit.get(question.id);
        if (answer?.type === "choice") {
          n += 1;
          counts[answer.choice] = (counts[answer.choice] ?? 0) + 1;
        }
      });
      summary[question.id] = { type: "choice", n, counts };
    } else {
      let sum = 0;
      let n = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      const scored: { unitIndex: number; score: number }[] = [];
      results.forEach((byUnit, unitIndex) => {
        const answer = byUnit.get(question.id);
        if (answer?.type === "score") {
          n += 1;
          sum += answer.score;
          min = Math.min(min, answer.score);
          max = Math.max(max, answer.score);
          scored.push({ unitIndex, score: answer.score });
        }
      });
      scored.sort((a, b) => a.score - b.score);
      summary[question.id] = {
        type: "score",
        n,
        mean: n > 0 ? sum / n : 0,
        min: n > 0 ? min : 0,
        max: n > 0 ? max : 0,
        lowest: scored.slice(0, LOWEST_LIMIT).map(({ unitIndex }) => units[unitIndex]?.id ?? ""),
      };
    }
  }
  return summary;
}

/** Headroom under REQUEST_BUDGET_CHARS so questions fit beside the state. */
export const STATE_BUDGET_CHARS = 32_000;

interface Shard {
  units: Unit[];
  items: PlannedQuestion[];
}

/** Group pending items so each shard's unit sources fit the state budget.
 *  Item unitIndex values are remapped to the shard-local state; resultIndex
 *  keeps pointing at the global unit for answers and cache keys. */
export function shardItems(
  units: Unit[],
  pending: PlannedQuestion[],
  budget: number = STATE_BUDGET_CHARS,
): Shard[] {
  const byUnit = new Map<number, PlannedQuestion[]>();
  for (const item of pending) {
    const list = byUnit.get(item.resultIndex) ?? [];
    list.push(item);
    byUnit.set(item.resultIndex, list);
  }
  const shards: Shard[] = [];
  let current: Shard = { units: [], items: [] };
  let currentSize = 0;
  const flush = (): void => {
    if (current.units.length > 0) shards.push(current);
    current = { units: [], items: [] };
    currentSize = 0;
  };
  units.forEach((unit, globalIndex) => {
    const items = byUnit.get(globalIndex);
    if (!items || items.length === 0) return;
    if (current.units.length > 0 && currentSize + unit.source.length > budget) flush();
    const localIndex = current.units.length;
    current.units.push(unit);
    currentSize += unit.source.length;
    for (const item of items) current.items.push({ ...item, unitIndex: localIndex });
  });
  flush();
  return shards;
}

export async function ask(input: AskInput): Promise<Report> {
  const { units, questions } = input;
  const results = new Map<number, Map<string, UnitAnswer>>();
  const unanswered: Unanswered[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const cacheDir =
    !input.dryRun && input.cache?.enabled === true
      ? (input.cache.dir ?? defaultCacheDir())
      : undefined;
  const model = input.model ?? DEFAULT_MODEL;

  let cacheHits = 0;
  let pending = plannedQuestions(units, questions);
  if (cacheDir !== undefined) {
    const misses: PlannedQuestion[] = [];
    for (const item of pending) {
      const unit = units[item.resultIndex];
      const hit =
        unit === undefined
          ? undefined
          : await readCachedAnswer(cacheDir, cacheKey(model, unit.source, item.question), item.question.kind);
      if (hit === undefined) {
        misses.push(item);
        continue;
      }
      cacheHits += 1;
      let byUnit = results.get(item.resultIndex);
      if (!byUnit) {
        byUnit = new Map();
        results.set(item.resultIndex, byUnit);
      }
      byUnit.set(item.questionId, hit);
    }
    pending = misses;
  }
  const shards = shardItems(units, pending);

  let questionsAsked = 0;
  if (!input.dryRun && input.evaluator) {
    for (const shard of shards) {
      const shardState = stateFor(shard.units, input.context);
      const batches = chunkItems(JSON.stringify(shardState).length, shard.items);
      for (const batch of batches) {
        questionsAsked += batch.length;
        const outcome = await evaluateBatch(shardState, batch, input.evaluator, units);
        usage.inputTokens += outcome.usage.inputTokens;
        usage.outputTokens += outcome.usage.outputTokens;
        usage.totalTokens += outcome.usage.totalTokens;
        unanswered.push(...outcome.unanswered);
        for (const { resultIndex, questionId, answer } of outcome.answers) {
          let byUnit = results.get(resultIndex);
          if (!byUnit) {
            byUnit = new Map();
            results.set(resultIndex, byUnit);
          }
          byUnit.set(questionId, answer);
        }
        if (cacheDir !== undefined) {
          await Promise.all(
            batch.map(async (item) => {
              const answer = results.get(item.resultIndex)?.get(item.questionId);
              const unit = units[item.resultIndex];
              if (answer !== undefined && unit !== undefined) {
                await writeCachedAnswer(cacheDir, cacheKey(model, unit.source, item.question), answer);
              }
            }),
          );
        }
      }
    }
  }
  const unitResults: UnitResult[] = units.map((unit, index) => ({
    id: unit.id,
    path: unit.path,
    span: unit.span,
    answers: Object.fromEntries(results.get(index) ?? new Map()),
  }));

  const threshold = input.escalateBelow;
  const escalations: Escalation[] = [];
  if (threshold !== undefined) {
    units.forEach((unit, index) => {
      results.get(index)?.forEach((answer, questionId) => {
        if (
          (answer.type === "choice" || answer.type === "score") &&
          typeof answer.confidence === "number" &&
          answer.confidence < threshold
        ) {
          escalations.push({ unitId: unit.id, questionId, confidence: answer.confidence });
        }
      });
    });
    escalations.sort((a, b) => a.confidence - b.confidence);
  }

  return {
    version: 1,
    units: unitResults,
    summary: summarize(units, results, questions),
    usage,
    cache: { enabled: cacheDir !== undefined, hits: cacheHits, misses: questionsAsked },
    escalations,
    coverage: {
      unitsEnumerated: units.length,
      unitsAsked: input.dryRun ? 0 : units.length,
      questionsAsked,
      unanswered,
      complete: unanswered.length === 0,
    },
  };
}
