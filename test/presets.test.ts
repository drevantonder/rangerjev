import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  filterTestFiles,
  filterToPaths,
  gitChangedPaths,
  isTestFile,
} from "../src/splitter.js";
import type { ProjectFile } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("isTestFile", () => {
  it.each([
    ["a.test.ts", true],
    ["a.spec.js", true],
    ["src/foo.test.tsx", true],
    ["tests/a.ts", true],
    ["src/__tests__/a.ts", true],
    ["test/a.ts", true],
    ["src/a.ts", false],
    ["latest.ts", false],
    ["contest.ts", false],
    ["src/contest/foo.ts", false],
    ["attest.js", false],
  ])("%s -> %s", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe("filterTestFiles / filterToPaths", () => {
  const files: ProjectFile[] = [
    { path: "src/a.ts", source: "" },
    { path: "src/a.test.ts", source: "" },
    { path: "tests/b.ts", source: "" },
  ];

  it("keeps only test files", () => {
    expect(filterTestFiles(files).map((f) => f.path).sort()).toEqual([
      "src/a.test.ts",
      "tests/b.ts",
    ]);
  });

  it("intersects with a path list, normalizing prefixes", () => {
    expect(filterToPaths(files, ["./src/a.ts", "other.ts"]).map((f) => f.path)).toEqual([
      "src/a.ts",
    ]);
  });
});

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rangerjev-git-"));
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir });
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "test"]);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "init"]);
  return dir;
}

describe("gitChangedPaths", () => {
  it("lists working-tree edits and untracked files", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 999;\n");
    writeFileSync(join(dir, "src", "new.ts"), "export const n = 0;\n");
    const changed = await gitChangedPaths(dir);
    expect(changed.sort()).toEqual(["src/a.ts", "src/new.ts"]);
  });

  it("includes branch commits with a base ref", async () => {
    const dir = await initRepo();
    const git = (args: string[]) => execFileAsync("git", args, { cwd: dir });
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 3;\n");
    await git(["commit", "-qam", "second"]);
    const changed = await gitChangedPaths(dir, "HEAD~1");
    expect(changed).toContain("src/b.ts");
  });

  it("fails clearly outside a repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rangerjev-nogit-"));
    await expect(gitChangedPaths(dir)).rejects.toThrow("git rev-parse failed");
  });
});
