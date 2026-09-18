import { readdir, readFile, lstat } from "node:fs/promises";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync, Visitor } from "oxc-parser";
import { createJiti } from "jiti";
import { z } from "zod";
import type {
  ProjectFile,
  SplitterFile,
  SplitterKind,
  SplitterUnit,
  Unit,
  UnitFinder,
  UnitSpan,
} from "./types.js";

export const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".bb"]);

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < start) high = middle - 1;
    else if (offset >= next) low = middle + 1;
    else return middle + 1;
  }
  return starts.length;
}

function lineCount(source: string): number {
  if (source.length === 0) return 1;
  return lineOf(lineStarts(source), source.length);
}

export function spanOf(source: string, start: number, end: number): UnitSpan {
  const starts = lineStarts(source);
  return {
    start,
    end,
    startLine: lineOf(starts, Math.max(0, Math.min(start, source.length))),
    endLine: lineOf(starts, Math.max(0, Math.min(end, source.length))),
  };
}

function toPosix(cwd: string, absolute: string): string {
  return relative(cwd, absolute).split(sep).join("/");
}

async function walk(
  absolute: string,
  cwd: string,
  extensions: Set<string>,
  out: string[],
): Promise<void> {
  // lstat: never follow symlinks (avoids cycles and dangling targets), and
  // skip entries that vanish mid-walk (sockets, lock files, removed files).
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    if (SKIPPED_DIRS.has(absolute.split(sep).pop() ?? "")) return;
    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch {
      return;
    }
    for (const entry of entries) {
      await walk(join(absolute, entry), cwd, extensions, out);
    }
    return;
  }
  if (info.isFile() && extensions.has(extname(absolute).toLowerCase())) {
    out.push(toPosix(cwd, absolute));
  }
}

export async function collectFiles(
  cwd: string,
  patterns: string[],
  extraExtensions: string[],
): Promise<ProjectFile[]> {
  const extensions = new Set([
    ...DEFAULT_EXTENSIONS,
    ...extraExtensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
  ]);
  const roots = patterns.length > 0 ? patterns : ["."];
  const found = new Set<string>();
  for (const pattern of roots) {
    const absolute = resolve(cwd, pattern);
    try {
      await lstat(absolute);
    } catch {
      throw new Error(`no such file or directory: ${pattern}`);
    }
    const bucket: string[] = [];
    await walk(absolute, cwd, extensions, bucket);
    for (const path of bucket) found.add(path);
  }
  const sorted = [...found].sort();
  const files: ProjectFile[] = [];
  for (const path of sorted) {
    files.push({ path, source: await readFile(resolve(cwd, path), "utf8") });
  }
  return files;
}

function fileUnit(file: ProjectFile, suffix = "file"): Unit {
  return {
    id: `${file.path}#${suffix}`,
    path: file.path,
    source: file.source,
    span: { start: 0, end: file.source.length, startLine: 1, endLine: lineCount(file.source) },
  };
}

export function splitFileUnits(files: ProjectFile[]): Unit[] {
  return files.map((file) => fileUnit(file));
}

type FnNode = { start: number; end: number };

export function splitFunctionUnits(files: ProjectFile[]): Unit[] {
  const units: Unit[] = [];
  for (const file of files) {
    let parsed: ReturnType<typeof parseSync>;
    try {
      parsed = parseSync(file.path, file.source, { range: true });
    } catch {
      units.push(fileUnit(file));
      continue;
    }
    if (parsed.errors.some((error) => error.severity === "Error")) {
      units.push(fileUnit(file));
      continue;
    }
    const nodes: FnNode[] = [];
    const add = (node: FnNode): void => {
      nodes.push(node);
    };
    new Visitor({
      ArrowFunctionExpression: add,
      FunctionDeclaration: add,
      FunctionExpression: add,
    }).visit(parsed.program);
    if (nodes.length === 0) {
      units.push(fileUnit(file));
      continue;
    }
    nodes.sort((left, right) => left.start - right.start || left.end - right.end);
    nodes.forEach((node, index) => {
      const start = Math.max(0, node.start);
      const end = Math.max(start, node.end);
      units.push({
        id: `${file.path}#fn${index}`,
        path: file.path,
        source: file.source.slice(start, end),
        span: spanOf(file.source, start, end),
      });
    });
  }
  return units;
}

function specifierTargets(from: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  // TypeScript-style imports often keep a .js suffix that points at a .ts file.
  const dot = base.lastIndexOf(".");
  const stripped = dot > 0 ? base.slice(0, dot) : base;
  const bases = stripped === base ? [base] : [base, stripped];
  const candidates: string[] = [];
  for (const root of bases) {
    candidates.push(root);
    for (const ext of DEFAULT_EXTENSIONS) candidates.push(`${root}${ext}`);
    for (const ext of DEFAULT_EXTENSIONS) candidates.push(posix.join(root, `index${ext}`));
  }
  return candidates;
}

export function reachableFiles(files: ProjectFile[], entry: string, depth: number): ProjectFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const normalizedEntry = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!byPath.has(normalizedEntry)) {
    throw new Error(`entry not in scope: ${entry}`);
  }
  const seen = new Set<string>([normalizedEntry]);
  let frontier = [normalizedEntry];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      const file = byPath.get(path);
      if (!file) continue;
      let program: unknown;
      try {
        const parsed = parseSync(path, file.source, { range: true });
        if (parsed.errors.some((error) => error.severity === "Error")) continue;
        program = parsed.program;
      } catch {
        continue;
      }
      const specifiers: string[] = [];
      new Visitor({
        ImportDeclaration(node: { source?: { value?: unknown } }) {
          if (typeof node.source?.value === "string") specifiers.push(node.source.value);
        },
        ExportAllDeclaration(node: { source?: { value?: unknown } }) {
          if (typeof node.source?.value === "string") specifiers.push(node.source.value);
        },
      }).visit(program as never);
      for (const specifier of specifiers) {
        for (const target of specifierTargets(path, specifier)) {
          if (byPath.has(target) && !seen.has(target)) {
            seen.add(target);
            next.push(target);
          }
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...seen].sort().map((path) => byPath.get(path) as ProjectFile);
}

export async function splitBy(
  kind: SplitterKind,
  files: ProjectFile[],
  options: { entry?: string; depth?: number },
): Promise<Unit[]> {
  if (kind === "file") return splitFileUnits(files);
  if (kind === "function") return splitFunctionUnits(files);
  if (options.entry === undefined) throw new Error("--by call-tree requires --entry <path>");
  const depth = options.depth ?? 3;
  return splitFileUnits(reachableFiles(files, options.entry, depth));
}

const splitterUnitSchema = z.object({
  path: z.string().min(1).optional(),
  source: z.string().optional(),
  span: z
    .object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    })
    .optional(),
  id: z.string().min(1).optional(),
});

export function describeForSplitter(file: ProjectFile): SplitterFile {
  let program: unknown = undefined;
  let comments: { start: number; end: number }[] = [];
  let hasErrors = true;
  try {
    const parsed = parseSync(file.path, file.source, { range: true });
    program = parsed.program;
    comments = parsed.comments.map((comment) => ({ start: comment.start, end: comment.end }));
    hasErrors = parsed.errors.some((error) => error.severity === "Error");
  } catch {
    hasErrors = true;
  }
  return { path: file.path, source: file.source, parsed: { program, comments, hasErrors } };
}

export async function loadUnitFinder(cwd: string, finderPath: string): Promise<UnitFinder> {
  const absolute = resolve(cwd, finderPath);
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const imported = await jiti.import<unknown>(pathToFileURL(absolute).href, { default: true });
  const candidate =
    typeof imported === "function"
      ? imported
      : (imported as { find?: unknown; default?: unknown })?.find ??
        (imported as { default?: unknown })?.default;
  const fn =
    typeof candidate === "function"
      ? candidate
      : typeof (candidate as { find?: unknown })?.find === "function"
        ? (candidate as { find: UnitFinder }).find
        : undefined;
  if (typeof fn !== "function") {
    throw new Error(`unit finder ${finderPath} must default-export a function or { find }`);
  }
  return fn as UnitFinder;
}

export async function splitCustom(files: ProjectFile[], finder: UnitFinder): Promise<Unit[]> {
  const described = files.map(describeForSplitter);
  const raw = await finder(described);
  const units: Unit[] = [];
  const byPath = new Map(files.map((file) => [file.path, file.source]));
  raw.forEach((item, index) => {
    const parsed = splitterUnitSchema.parse(item) as SplitterUnit;
    const fallbackPath = parsed.path ?? (files.length === 1 ? files[0]?.path : undefined);
    if (fallbackPath === undefined) {
      throw new Error(
        `unit finder returned a unit with no path (index ${index}); ` +
          "set path per unit when splitting multiple files",
      );
    }
    const path = fallbackPath;
    const owner = byPath.get(path) ?? "";
    const span = parsed.span;
    let source = parsed.source;
    let unitSpan: UnitSpan;
    if (span !== undefined && owner !== "") {
      const start = Math.max(0, Math.min(span.start, owner.length));
      const end = Math.max(start, Math.min(span.end, owner.length));
      source ??= owner.slice(start, end);
      unitSpan = {
        start,
        end,
        startLine: span.startLine ?? 1,
        endLine: span.endLine ?? lineCount(source),
      };
      if (span.startLine === undefined || span.endLine === undefined) {
        const computed = spanOf(owner, start, end);
        unitSpan.startLine = computed.startLine;
        unitSpan.endLine = computed.endLine;
      }
    } else if (source !== undefined) {
      unitSpan = { start: 0, end: source.length, startLine: 1, endLine: lineCount(source) };
    } else if (owner !== "") {
      source = owner;
      unitSpan = { start: 0, end: owner.length, startLine: 1, endLine: lineCount(owner) };
    } else {
      throw new Error(`unit finder returned a unit with no path or source (index ${index})`);
    }
    units.push({ id: parsed.id ?? `${path}#custom${index}`, path, source, span: unitSpan });
  });
  return units;
}

export function defineUnitFinder(_name: string, finder: UnitFinder): UnitFinder {
  return finder;
}

