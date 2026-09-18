import type { JsonValue, Questions } from "@typesafe-ai/sdk";
export interface BatchAnswer {
    type: string;
    noul?: unknown;
    choice?: unknown;
    score?: unknown;
    probabilities?: unknown;
    confidence?: unknown;
}
export interface BatchResult {
    answers: Record<string, BatchAnswer>;
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}
export type AskState = {
    [key: string]: JsonValue;
};
export declare class RangerEvaluator {
    readonly model: string;
    private readonly endpoint;
    private client;
    constructor();
    ask(state: AskState, questions: Questions): Promise<BatchResult>;
}
