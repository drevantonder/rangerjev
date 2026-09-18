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
});
