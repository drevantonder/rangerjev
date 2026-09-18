import type { EntryType, JsonValue, Question, Questions } from "@typesafe-ai/sdk";
import type { BatchAnswer, RangerEvaluator } from "./evaluator.js";
import type {
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
  unitIndex: number;
  questionId: string;
  question: NamedQuestion;
}

export interface AskInput {
  units: Unit[];
  questions: NamedQuestion[];
  context?: string;
  dryRun?: boolean;
  evaluator?: Pick<RangerEvaluator, "ask">;
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

function plannedQuestions(units: Unit[], questions: NamedQuestion[]): PlannedQuestion[] {
  void units;
  const planned: PlannedQuestion[] = [];
  units.forEach((_unit, unitIndex) => {
    for (const question of questions) {
      planned.push({
        key: `${question.id}__${unitIndex}`,
        unitIndex,
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

export function planBatches(
  units: Unit[],
  questions: NamedQuestion[],
  context?: string,
): PlannedQuestion[][] {
  const state = stateFor(units, context);
  const baseSize = JSON.stringify(state).length;
  const batches: PlannedQuestion[][] = [];
  let current: PlannedQuestion[] = [];
  let currentSize = baseSize;
  for (const item of plannedQuestions(units, questions)) {
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

async function evaluateBatch(
  state: { [key: string]: JsonValue },
  batch: PlannedQuestion[],
  evaluator: Pick<RangerEvaluator, "ask">,
  results: Map<number, Map<string, UnitAnswer>>,
  unanswered: Unanswered[],
  units: Unit[],
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
): Promise<void> {
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
      await evaluateBatch(state, batch.slice(0, middle), evaluator, results, unanswered, units, usage);
      await evaluateBatch(state, batch.slice(middle), evaluator, results, unanswered, units, usage);
      return;
    }
    for (const item of batch) {
      unanswered.push({
        unitId: units[item.unitIndex]?.id ?? `unit_${item.unitIndex}`,
        questionId: item.questionId,
        message: message.replaceAll(/\s+/g, " ").trim().slice(0, 300),
      });
    }
    return;
  }
  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  usage.totalTokens += result.usage.totalTokens;
  for (const item of batch) {
    const checked = checkAnswer(item.question, result.answers[item.key]);
    if (typeof checked === "string") {
      unanswered.push({
        unitId: units[item.unitIndex]?.id ?? `unit_${item.unitIndex}`,
        questionId: item.questionId,
        message: checked,
      });
      continue;
    }
    let byUnit = results.get(item.unitIndex);
    if (!byUnit) {
      byUnit = new Map();
      results.set(item.unitIndex, byUnit);
    }
    byUnit.set(item.questionId, checked);
  }
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

export async function ask(input: AskInput): Promise<Report> {
  const { units, questions } = input;
  const results = new Map<number, Map<string, UnitAnswer>>();
  const unanswered: Unanswered[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const state = stateFor(units, input.context);
  const batches = planBatches(units, questions, input.context);

  let questionsAsked = 0;
  if (!input.dryRun && input.evaluator) {
    for (const batch of batches) {
      questionsAsked += batch.length;
      await evaluateBatch(state, batch, input.evaluator, results, unanswered, units, usage);
    }
  }

  const unitResults: UnitResult[] = units.map((unit, index) => ({
    id: unit.id,
    path: unit.path,
    span: unit.span,
    answers: Object.fromEntries(results.get(index) ?? new Map()),
  }));

  return {
    version: 1,
    units: unitResults,
    summary: summarize(units, results, questions),
    usage,
    coverage: {
      unitsEnumerated: units.length,
      unitsAsked: input.dryRun ? 0 : units.length,
      questionsAsked,
      unanswered,
      complete: unanswered.length === 0,
    },
  };
}
