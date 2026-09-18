import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import envPaths from "env-paths";
import type { NamedQuestion, UnitAnswer } from "./types.js";

const CACHE_VERSION = 1;

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CACHE_HOME"]?.trim();
  if (xdg) return join(xdg, "rangerjev", `v${CACHE_VERSION}`);
  return join(envPaths("rangerjev", { suffix: "" }).cache, `v${CACHE_VERSION}`);
}

/** Content-addressed key: same model + source + question always hits. */
export function cacheKey(model: string, source: string, question: NamedQuestion): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: CACHE_VERSION, model, source, question: question.question }))
    .digest("hex");
}

function keyPath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function looksLikeAnswer(value: unknown, kind: NamedQuestion["kind"]): value is UnitAnswer {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === kind;
}

export async function readCachedAnswer(
  dir: string,
  key: string,
  kind: NamedQuestion["kind"],
): Promise<UnitAnswer | undefined> {
  let raw: string;
  try {
    raw = await readFile(keyPath(dir, key), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return looksLikeAnswer(parsed, kind) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCachedAnswer(
  dir: string,
  key: string,
  answer: UnitAnswer,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = keyPath(dir, `${key}.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(answer));
  try {
    await rename(tmp, keyPath(dir, key));
  } catch {
    // Best-effort: a lost race on the same key just drops one copy.
  }
}
