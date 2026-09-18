#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rangerError } from "./errors.js";
import { MISSING_API_KEY_MESSAGE, RangerEvaluator, resolveApiKey } from "./evaluator.js";
import { parseFile, parseInline } from "./questions.js";
import type { InlineQuestions } from "./questions.js";
import { ask } from "./run.js";
import {
  collectFiles,
  filterTestFiles,
  filterToPaths,
  gitChangedPaths,
  loadUnitFinder,
  splitBy,
  splitCustom,
} from "./splitter.js";
import type { NamedQuestion, Report, SplitterKind, Unit } from "./types.js";

const HELP = `Usage: rangerjev [PATH]... [options]

Ask typed questions of a codebase.

  --by <kind>            file | function | call-tree (default: file)
  --entry <path>         call-tree root (required with --by call-tree)
  --depth <n>            call-tree import depth (default: 3)
  --unit-finder <path>   custom splitter module (overrides --by)
  --questions <path>     JSON file of named typed questions
  --boolean <id=text>    P(yes) question (repeatable)
  --choice <id=text>     categorical question (repeatable)
  --choices <id=a,b,..>  options for a choice question (repeatable)
  --score <id=text>      ordered-level question (repeatable)
  --levels <id=a,b,..>   ordered levels, low to high (repeatable)
  --context <path>       extra text file included once in every request state
  --tests-only           only test files (*.test.*, tests/, __tests__/)
  --changed              only files changed in the working tree (git)
  --base <ref>           with --changed, also include files differing from <ref>
  --escalate-below <p>   list choice/score answers with confidence below p (0-1)
  --ext <.a,.b>          extra file extensions beyond JS/TS (repeatable)
  --max-units <n>        ask only the first n units in path order
  --dry-run              enumerate units and count questions, zero live requests
  --no-cache             skip the response cache (on by default)
  --cache-dir <path>     cache directory (default: $XDG_CACHE_HOME/rangerjev)
  --version              print the version
  --help                 show this help

Stdout carries only the report JSON. All chatter
goes to stderr. Exit 0 means every unit was answered; exit 1 means invalid
input, a provider failure, unanswered questions, or skipped paths.
`;

interface Options {
  paths: string[];
  showHelp: boolean;
  showVersion: boolean;
  noCache: boolean;
  cacheDir?: string;
  testsOnly: boolean;
  changed: boolean;
  base?: string;
  escalateBelow?: number;
  by: SplitterKind;
  entry?: string;
  depth: number;
  unitFinder?: string;
  questionsPath?: string;
  inline: InlineQuestions;
  contextPath?: string;
  extraExts: string[];
  maxUnits?: number;
  dryRun: boolean;
}

function fail(stderr: (text: string) => void, message: string): number {
  stderr(`rangerjev: ${message}\n`);
  return 1;
}

function parseCount(raw: string | undefined, flag: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw rangerError("RANGERJEV_BAD_COUNT", `${flag} must be an integer >= ${min}, got: ${raw}`);
  }
  return parsed;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    paths: [],
    showHelp: false,
    showVersion: false,
    noCache: false,
    testsOnly: false,
    changed: false,
    by: "file",
    depth: 3,
    inline: { booleans: [], choices: [], choicesFor: [], scores: [], levelsFor: [] },
    extraExts: [],
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const next = (): string => {
      const value = args[index + 1];
      if (value === undefined) throw rangerError("RANGERJEV_MISSING_VALUE", `${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--help") {
      options.showHelp = true;
    } else if (arg === "--version") {
      options.showVersion = true;
    } else if (arg === "--by") {
      const value = next();
      if (value !== "file" && value !== "function" && value !== "call-tree") {
        throw rangerError("RANGERJEV_BAD_SPLITTER", `--by must be file, function, or call-tree, got: ${value}`);
      }
      options.by = value;
    } else if (arg === "--entry") options.entry = next();
    else if (arg === "--depth") options.depth = parseCount(next(), "--depth", 0) ?? 3;
    else if (arg === "--unit-finder") options.unitFinder = next();
    else if (arg === "--questions") options.questionsPath = next();
    else if (arg === "--boolean") options.inline.booleans.push(next());
    else if (arg === "--choice") options.inline.choices.push(next());
    else if (arg === "--choices") options.inline.choicesFor.push(next());
    else if (arg === "--score") options.inline.scores.push(next());
    else if (arg === "--levels") options.inline.levelsFor.push(next());
    else if (arg === "--context") options.contextPath = next();
    else if (arg === "--tests-only") options.testsOnly = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--base") options.base = next();
    else if (arg === "--escalate-below") {
      const raw = next();
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw rangerError("RANGERJEV_BAD_THRESHOLD", `--escalate-below must be between 0 and 1, got: ${raw}`);
      }
      options.escalateBelow = value;
    }
    else if (arg === "--ext") {
      options.extraExts.push(
        ...next()
          .split(",")
          .map((ext) => ext.trim())
          .filter((ext) => ext !== ""),
      );
    } else if (arg === "--max-units") options.maxUnits = parseCount(next(), "--max-units", 1);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-cache") options.noCache = true;
    else if (arg === "--cache-dir") options.cacheDir = next();
    else if (arg === "--") {
      options.paths.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw rangerError("RANGERJEV_UNKNOWN_FLAG", `unknown flag: ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

export async function runCli(
  args: string[],
  dependencies: {
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return fail(stderr, error instanceof Error ? error.message : String(error));
  }
  const cwd = dependencies.cwd ?? process.cwd();
  if (options.showVersion) {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    stdout(`rangerjev ${typeof pkg.version === "string" ? pkg.version : "unknown"}\n`);
    return 0;
  }
  if (options.showHelp) {
    stdout(HELP);
    return 0;
  }

  let questions: NamedQuestion[];
  try {
    const inline = parseInline(options.inline);
    const taken = new Set(inline.map((question) => question.id));
    const fromFile =
      options.questionsPath === undefined
        ? []
        : await parseFile(cwd, options.questionsPath, taken);
    questions = [...inline, ...fromFile];
  } catch (error) {
    return fail(stderr, error instanceof Error ? error.message : String(error));
  }
  if (questions.length === 0) {
    return fail(stderr, "[RANGERJEV_NO_QUESTIONS] no questions: pass --questions or an inline --boolean/--choice/--score");
  }

  let collected;
  try {
    collected = await collectFiles(cwd, options.paths, options.extraExts, (entry) =>
      stderr(`rangerjev: skipped unreadable path: ${entry.path} (${entry.reason})\n`),
    );
  } catch (error) {
    return fail(stderr, error instanceof Error ? error.message : String(error));
  }
  let files = collected.files;
  const skipped = collected.skipped;
  if (files.length === 0) {
    return fail(stderr, "[RANGERJEV_NO_FILES] no source files matched the given paths");
  }
  if (options.testsOnly) {
    files = filterTestFiles(files);
    if (files.length === 0) {
      return fail(stderr, "[RANGERJEV_NO_TEST_FILES] --tests-only matched no test files in the given paths");
    }
  }
  if (options.changed || options.base !== undefined) {
    let changed: string[];
    try {
      changed = await gitChangedPaths(cwd, options.base);
    } catch (error) {
      return fail(stderr, error instanceof Error ? error.message : String(error));
    }
    files = filterToPaths(files, changed);
    if (files.length === 0) {
      return fail(stderr, "[RANGERJEV_NO_CHANGED_FILES] --changed matched no collected files (nothing changed or scope excludes them)");
    }
  }

  let units: Unit[];
  try {
    if (options.unitFinder !== undefined) {
      units = await splitCustom(files, await loadUnitFinder(cwd, options.unitFinder));
    } else {
      units = await splitBy(options.by, files, { entry: options.entry, depth: options.depth });
    }
  } catch (error) {
    return fail(stderr, error instanceof Error ? error.message : String(error));
  }
  units.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  if (options.maxUnits !== undefined) units = units.slice(0, options.maxUnits);
  if (units.length === 0) return fail(stderr, "[RANGERJEV_NO_UNITS] no units to ask about");

  let context: string | undefined;
  if (options.contextPath !== undefined) {
    try {
      context = await readFile(resolve(cwd, options.contextPath), "utf8");
    } catch (error) {
      return fail(stderr, `[RANGERJEV_BAD_CONTEXT] cannot read --context file: ${(error as Error).message}`);
    }
  }

  if (options.dryRun) {
    const planned = units.length * questions.length;
    stderr(
      `rangerjev: dry run: ${units.length} units x ${questions.length} questions = ${planned} planned questions, 0 live requests\n`,
    );
    const report = await ask({ units, questions, context, dryRun: true });
    if (skipped.length > 0) {
      report.coverage.skipped = skipped;
      report.coverage.complete = false;
      const names = skipped.slice(0, 5).map((entry) => entry.path).join(", ");
      stderr(`rangerjev: ${skipped.length} unreadable path(s) excluded: ${names}${skipped.length > 5 ? ", ..." : ""}\n`);
    }
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.coverage.complete ? 0 : 1;
  }

  const apiKey = resolveApiKey();
  if (apiKey === undefined) return fail(stderr, MISSING_API_KEY_MESSAGE);

  let report: Report;
  try {
    const evaluator = new RangerEvaluator(apiKey);
    report = await ask({
      units,
      questions,
      context,
      evaluator,
      model: evaluator.model,
      cache: { enabled: !options.noCache, dir: options.cacheDir },
      escalateBelow: options.escalateBelow,
    });
  } catch (error) {
    return fail(stderr, error instanceof Error ? error.message : String(error));
  }

  stdout(`${JSON.stringify(report, null, 2)}\n`);
  if (report.cache.enabled) {
    stderr(`rangerjev: cache ${report.cache.hits} hits, ${report.cache.misses} misses\n`);
  }
  if (skipped.length > 0) {
    report.coverage.skipped = skipped;
    report.coverage.complete = false;
    const names = skipped.slice(0, 5).map((entry) => entry.path).join(", ");
    stderr(`rangerjev: ${skipped.length} unreadable path(s) excluded: ${names}${skipped.length > 5 ? ", ..." : ""}\n`);
  }
  return report.coverage.complete ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath) {
  // realpath: the bin is a symlink under npm -g / npm link installs.
  let invokedUrl: string | undefined;
  try {
    invokedUrl = pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    invokedUrl = undefined;
  }
  if (invokedUrl !== undefined && import.meta.url === invokedUrl) {
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
