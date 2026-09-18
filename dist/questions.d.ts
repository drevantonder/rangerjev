import type { NamedQuestion } from "./types.js";
export interface InlineQuestions {
    booleans: string[];
    choices: string[];
    choicesFor: string[];
    scores: string[];
    levelsFor: string[];
}
export declare function parseInline(inline: InlineQuestions): NamedQuestion[];
export declare function parseFile(cwd: string, path: string, taken: Set<string>): Promise<NamedQuestion[]>;
