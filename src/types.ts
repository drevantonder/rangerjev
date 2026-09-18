import type { JsonValue, Question } from "@typesafe-ai/sdk";

export type SplitterKind = "file" | "function" | "call-tree";

/** `boolean` is the CLI spelling; `noul` is accepted as an alias. */
export type QuestionKind = "boolean" | "noul" | "choice" | "score";

export interface UnitSpan {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface Unit {
  id: string;
  path: string;
  source: string;
  span: UnitSpan;
}

export interface ProjectFile {
  path: string;
  source: string;
}

/** A parsed program handed to custom splitters (re-exported oxc shapes). */
export interface ParseContext {
  program: unknown;
  comments: { start: number; end: number }[];
  hasErrors: boolean;
}

export interface SplitterFile {
  path: string;
  source: string;
  parsed: ParseContext;
}

/** A custom splitter: files in, units out. Returned `source` may be omitted
 *  to keep the sliced span text; `span` may be omitted for whole-source units. */
export interface SplitterUnit {
  path?: string;
  source?: string;
  span?: { start: number; end: number; startLine?: number; endLine?: number };
  id?: string;
}

export type UnitFinder = (files: SplitterFile[]) => SplitterUnit[] | Promise<SplitterUnit[]>;

export interface NamedQuestion {
  id: string;
  kind: Exclude<QuestionKind, "noul">;
  question: Question;
}

export interface BooleanAnswer {
  type: "boolean";
  probability: number;
  confidence?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type UnitAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export interface UnitResult {
  id: string;
  path: string;
  span: UnitSpan;
  answers: Record<string, UnitAnswer>;
}

export interface Unanswered {
  unitId: string;
  questionId: string;
  message: string;
}

export interface Escalation {
  unitId: string;
  questionId: string;
  /** Reported confidence that fell below the --escalate-below threshold. */
  confidence: number;
}

export interface ReportSummary {
  [questionId: string]:
    | { type: "boolean"; n: number; mean: number; yes: number }
    | { type: "choice"; n: number; counts: Record<string, number> }
    | { type: "score"; n: number; mean: number; min: number; max: number; lowest: string[] };
}

export interface Report {
  version: 1;
  units: UnitResult[];
  summary: ReportSummary;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cache: { enabled: boolean; hits: number; misses: number };
  /** Choice/score answers below the escalation threshold, worst first.
   *  Empty unless --escalate-below is set. Boolean answers never escalate:
   *  Jev reports no confidence for yes/no judgments. */
  escalations: Escalation[];
  coverage: {
    unitsEnumerated: number;
    unitsAsked: number;
    questionsAsked: number;
    unanswered: Unanswered[];
    complete: boolean;
  };
  truncatedContext?: boolean;
}

export type { JsonValue };
