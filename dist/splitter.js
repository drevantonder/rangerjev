import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync, Visitor } from "oxc-parser";
import { createJiti } from "jiti";
import { z } from "zod";
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
function lineStarts(source) {
    const starts = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n")
            starts.push(index + 1);
    }
    return starts;
}
function lineOf(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const start = starts[middle] ?? 0;
        const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
        if (offset < start)
            high = middle - 1;
        else if (offset >= next)
            low = middle + 1;
        else
            return middle + 1;
    }
    return starts.length;
}
function lineCount(source) {
    if (source.length === 0)
        return 1;
    return lineOf(lineStarts(source), source.length);
}
export function spanOf(source, start, end) {
    const starts = lineStarts(source);
    return {
        start,
        end,
        startLine: lineOf(starts, Math.max(0, Math.min(start, source.length))),
        endLine: lineOf(starts, Math.max(0, Math.min(end, source.length))),
    };
}
function toPosix(cwd, absolute) {
    return relative(cwd, absolute).split(sep).join("/");
}
async function walk(absolute, cwd, extensions, out) {
    const info = await stat(absolute);
    if (info.isDirectory()) {
        if (SKIPPED_DIRS.has(absolute.split(sep).pop() ?? ""))
            return;
        for (const entry of await readdir(absolute)) {
            await walk(join(absolute, entry), cwd, extensions, out);
        }
        return;
    }
    if (extensions.has(extname(absolute).toLowerCase()))
        out.push(toPosix(cwd, absolute));
}
export async function collectFiles(cwd, patterns, extraExtensions) {
    const extensions = new Set([
        ...DEFAULT_EXTENSIONS,
        ...extraExtensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
    ]);
    const roots = patterns.length > 0 ? patterns : ["."];
    const found = new Set();
    for (const pattern of roots) {
        const absolute = resolve(cwd, pattern);
        const bucket = [];
        try {
            await walk(absolute, cwd, extensions, bucket);
        }
        catch {
            throw new Error(`no such file or directory: ${pattern}`);
        }
        for (const path of bucket)
            found.add(path);
    }
    const sorted = [...found].sort();
    const files = [];
    for (const path of sorted) {
        files.push({ path, source: await readFile(resolve(cwd, path), "utf8") });
    }
    return files;
}
function fileUnit(file, suffix = "file") {
    return {
        id: `${file.path}#${suffix}`,
        path: file.path,
        source: file.source,
        span: { start: 0, end: file.source.length, startLine: 1, endLine: lineCount(file.source) },
    };
}
export function splitFileUnits(files) {
    return files.map((file) => fileUnit(file));
}
export function splitFunctionUnits(files) {
    const units = [];
    for (const file of files) {
        let parsed;
        try {
            parsed = parseSync(file.path, file.source, { range: true });
        }
        catch {
            units.push(fileUnit(file));
            continue;
        }
        if (parsed.errors.some((error) => error.severity === "Error")) {
            units.push(fileUnit(file));
            continue;
        }
        const nodes = [];
        const add = (node) => {
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
function specifierTargets(from, specifier) {
    if (!specifier.startsWith("."))
        return [];
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    // TypeScript-style imports often keep a .js suffix that points at a .ts file.
    const dot = base.lastIndexOf(".");
    const stripped = dot > 0 ? base.slice(0, dot) : base;
    const bases = stripped === base ? [base] : [base, stripped];
    const candidates = [];
    for (const root of bases) {
        candidates.push(root);
        for (const ext of DEFAULT_EXTENSIONS)
            candidates.push(`${root}${ext}`);
        for (const ext of DEFAULT_EXTENSIONS)
            candidates.push(posix.join(root, `index${ext}`));
    }
    return candidates;
}
export function reachableFiles(files, entry, depth) {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const normalizedEntry = entry.replace(/\\/g, "/");
    if (!byPath.has(normalizedEntry)) {
        throw new Error(`entry not in scope: ${entry}`);
    }
    const seen = new Set([normalizedEntry]);
    let frontier = [normalizedEntry];
    for (let level = 0; level < depth; level += 1) {
        const next = [];
        for (const path of frontier) {
            const file = byPath.get(path);
            if (!file)
                continue;
            let program;
            try {
                const parsed = parseSync(path, file.source, { range: true });
                if (parsed.errors.some((error) => error.severity === "Error"))
                    continue;
                program = parsed.program;
            }
            catch {
                continue;
            }
            const specifiers = [];
            new Visitor({
                ImportDeclaration(node) {
                    if (typeof node.source?.value === "string")
                        specifiers.push(node.source.value);
                },
                ExportAllDeclaration(node) {
                    if (typeof node.source?.value === "string")
                        specifiers.push(node.source.value);
                },
            }).visit(program);
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
        if (frontier.length === 0)
            break;
    }
    return [...seen].sort().map((path) => byPath.get(path));
}
export async function splitBy(kind, files, options) {
    if (kind === "file")
        return splitFileUnits(files);
    if (kind === "function")
        return splitFunctionUnits(files);
    if (options.entry === undefined)
        throw new Error("--by call-tree requires --entry <path>");
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
export function describeForSplitter(file) {
    let program = undefined;
    let comments = [];
    let hasErrors = true;
    try {
        const parsed = parseSync(file.path, file.source, { range: true });
        program = parsed.program;
        comments = parsed.comments.map((comment) => ({ start: comment.start, end: comment.end }));
        hasErrors = parsed.errors.some((error) => error.severity === "Error");
    }
    catch {
        hasErrors = true;
    }
    return { path: file.path, source: file.source, parsed: { program, comments, hasErrors } };
}
export async function loadUnitFinder(cwd, finderPath) {
    const absolute = resolve(cwd, finderPath);
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const imported = await jiti.import(pathToFileURL(absolute).href, { default: true });
    const candidate = typeof imported === "function"
        ? imported
        : imported?.find ??
            imported?.default;
    const fn = typeof candidate === "function"
        ? candidate
        : typeof candidate?.find === "function"
            ? candidate.find
            : undefined;
    if (typeof fn !== "function") {
        throw new Error(`unit finder ${finderPath} must default-export a function or { find }`);
    }
    return fn;
}
export async function splitCustom(files, finder) {
    const described = files.map(describeForSplitter);
    const raw = await finder(described);
    const units = [];
    const byPath = new Map(files.map((file) => [file.path, file.source]));
    raw.forEach((item, index) => {
        const parsed = splitterUnitSchema.parse(item);
        const path = parsed.path ?? described[index]?.path ?? `unit_${index}`;
        const owner = byPath.get(path) ?? "";
        const span = parsed.span;
        let source = parsed.source;
        let unitSpan;
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
        }
        else if (source !== undefined) {
            unitSpan = { start: 0, end: source.length, startLine: 1, endLine: lineCount(source) };
        }
        else if (owner !== "") {
            source = owner;
            unitSpan = { start: 0, end: owner.length, startLine: 1, endLine: lineCount(owner) };
        }
        else {
            throw new Error(`unit finder returned a unit with no path or source (index ${index})`);
        }
        units.push({ id: parsed.id ?? `${path}#custom${index}`, path, source, span: unitSpan });
    });
    return units;
}
export function defineUnitFinder(_name, finder) {
    return finder;
}
//# sourceMappingURL=splitter.js.map