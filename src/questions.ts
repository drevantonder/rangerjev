import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ChoiceQuestion, NoulQuestion, Question, ScoreQuestion } from "@typesafe-ai/sdk";
import type { NamedQuestion, QuestionKind } from "./types.js";

const entrySchema = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
  z.null(),
]);

const fileQuestionSchema = z.object({
  type: z.enum(["boolean", "noul", "choice", "score"]),
  instructions: entrySchema,
  criteria: z.unknown().optional(),
});

const fileSchema = z.record(z.string(), fileQuestionSchema);

export interface InlineQuestions {
  booleans: string[];
  choices: string[];
  choicesFor: string[];
  scores: string[];
  levelsFor: string[];
}

function splitIdValue(raw: string, flag: string): { id: string; value: string } {
  const index = raw.indexOf("=");
  if (index <= 0) throw new Error(`${flag} must look like id=text, got: ${raw}`);
  const id = raw.slice(0, index).trim();
  const value = raw.slice(index + 1);
  if (id === "" || value === "") throw new Error(`${flag} must look like id=text, got: ${raw}`);
  return { id, value };
}

function splitList(raw: string, flag: string): { id: string; items: string[] } {
  const { id, value } = splitIdValue(raw, flag);
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) throw new Error(`${flag} needs at least one value: ${raw}`);
  const duplicates = items.filter((item, index) => items.indexOf(item) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${flag} labels must be unique, duplicate: ${duplicates[0]}`);
  }
  return { id, items };
}

/** Build typed questions from inline CLI flags. Every mismatch throws naming
 *  the flag: duplicate ids, a --choice without --choices, a --score without
 *  --levels (or fewer than two levels), and orphaned --choices/--levels. */
export function parseInline(inline: InlineQuestions): NamedQuestion[] {
  const out: NamedQuestion[] = [];
  const seen = new Set<string>();
  const claim = (id: string, flag: string): void => {
    if (seen.has(id)) throw new Error(`duplicate question id: ${id} (from ${flag})`);
    seen.add(id);
  };

  const choicesById = new Map<string, string[]>();
  for (const raw of inline.choicesFor) {
    const { id, items } = splitList(raw, "--choices");
    if (choicesById.has(id)) throw new Error(`duplicate --choices for: ${id}`);
    choicesById.set(id, items);
  }
  const levelsById = new Map<string, string[]>();
  for (const raw of inline.levelsFor) {
    const { id, items } = splitList(raw, "--levels");
    if (levelsById.has(id)) throw new Error(`duplicate --levels for: ${id}`);
    levelsById.set(id, items);
  }

  for (const raw of inline.booleans) {
    const { id, value } = splitIdValue(raw, "--boolean");
    claim(id, "--boolean");
    const question: NoulQuestion = { type: "noul", instructions: value };
    out.push({ id, kind: "boolean", question });
  }
  for (const raw of inline.choices) {
    const { id, value } = splitIdValue(raw, "--choice");
    claim(id, "--choice");
    const options = choicesById.get(id);
    if (!options) throw new Error(`--choice ${id} needs a matching --choices ${id}=a,b,...`);
    const criteria: Record<string, string> = {};
    for (const option of options) criteria[option] = option;
    const question = { type: "choice", instructions: value, criteria } as ChoiceQuestion;
    out.push({ id, kind: "choice", question: question as Question });
  }
  for (const raw of inline.scores) {
    const { id, value } = splitIdValue(raw, "--score");
    claim(id, "--score");
    const levels = levelsById.get(id);
    if (!levels) throw new Error(`--score ${id} needs a matching --levels ${id}=low,...,high`);
    if (levels.length < 2) throw new Error(`--levels ${id} needs at least two levels`);
    const question = { type: "score", instructions: value, criteria: levels } as unknown as ScoreQuestion;
    out.push({ id, kind: "score", question: question as Question });
  }

  for (const id of choicesById.keys()) {
    if (!seen.has(id)) throw new Error(`--choices ${id} has no matching --choice question`);
  }
  for (const id of levelsById.keys()) {
    if (!seen.has(id)) throw new Error(`--levels ${id} has no matching --score question`);
  }
  return out;
}

/** Parse named questions from a JSON file. Adds every parsed id to `taken`
 *  (shared with the inline flags) and throws naming any duplicate, so ids
 *  stay unique across both question sources. */
export async function parseFile(
  cwd: string,
  path: string,
  taken: Set<string>,
): Promise<NamedQuestion[]> {
  const absolute = resolve(cwd, path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(`cannot read questions file ${path}: ${(error as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid questions file ${path}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
  }
  const out: NamedQuestion[] = [];
  for (const [id, entry] of Object.entries(parsed.data)) {
    if (taken.has(id)) throw new Error(`duplicate question id: ${id} (questions file vs flags)`);
    taken.add(id);
    const type = entry.type as QuestionKind;
    if (type === "boolean" || type === "noul") {
      const question: NoulQuestion = { type: "noul", instructions: entry.instructions };
      if (entry.criteria !== undefined) {
        question.criteria = entry.criteria as NoulQuestion["criteria"];
      }
      out.push({ id, kind: "boolean", question });
    } else if (type === "choice") {
      const criteria = entry.criteria as Record<string, unknown> | undefined;
      if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
        throw new Error(`choice question ${id} needs a nonempty criteria map`);
      }
      const question = {
        type: "choice",
        instructions: entry.instructions,
        criteria,
      } as ChoiceQuestion;
      out.push({ id, kind: "choice", question: question as Question });
    } else {
      const levels = entry.criteria as unknown[] | undefined;
      if (!Array.isArray(levels) || levels.length < 2) {
        throw new Error(`score question ${id} needs a criteria array with at least two levels`);
      }
      const question = {
        type: "score",
        instructions: entry.instructions,
        criteria: levels,
      } as unknown as ScoreQuestion;
      out.push({ id, kind: "score", question: question as Question });
    }
  }
  return out;
}
