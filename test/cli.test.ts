import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli --help", () => {
  it("prints usage to stdout and exits 0", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      cwd: process.cwd(),
      stdout: (text: string) => stdout.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage: rangerjev");
  });

  it("prints the version and exits 0", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--version"], {
      cwd: process.cwd(),
      stdout: (text: string) => stdout.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toMatch(/^rangerjev \d+\.\d+\.\d+/);
  });

  it.each([
    [["src", "--bogus"], "unknown flag"],
    [["src", "--by", "file"], "no questions"],
    [["src", "--by", "file", "--escalate-below", "2"], "--escalate-below"],
  ])("fails fast on invalid input: %s", async (args, message) => {
    const stderr: string[] = [];
    const code = await runCli(args, {
      cwd: process.cwd(),
      stdout: () => undefined,
      stderr: (text: string) => stderr.push(text),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain(message);
  });
});
