import type { RangerEvaluator } from "./evaluator.js";
import type { NamedQuestion, Report, ReportSummary, Unit, UnitAnswer } from "./types.js";
export declare const REQUEST_BUDGET_CHARS = 48000;
export declare const MAX_QUESTIONS_PER_REQUEST = 24;
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
export declare function planBatches(units: Unit[], questions: NamedQuestion[], context?: string): PlannedQuestion[][];
export declare function summarize(units: Unit[], results: Map<number, Map<string, UnitAnswer>>, questions: NamedQuestion[]): ReportSummary;
export declare function ask(input: AskInput): Promise<Report>;
export {};
