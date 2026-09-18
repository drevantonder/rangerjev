import { describe, expect, it } from "vitest";
import { MISSING_API_KEY_MESSAGE, resolveApiKey } from "../src/evaluator.js";
import { runCli } from "../src/cli.js";

describe("resolveApiKey", () => {
  it("reads the global TYPESAFE_API_KEY", () => {
    expect(resolveApiKey({ TYPESAFE_API_KEY: "key-123" } as NodeJS.ProcessEnv)).toBe("key-123");
  });

  it("treats blank values as missing", () => {
    expect(resolveApiKey({ TYPESAFE_API_KEY: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("runCli auth preflight", () => {
  it("fails fast with a clear message when the key is missing", async () => {
    const saved = process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];
    try {
      const stderr: string[] = [];
      const code = await runCli(
        ["src", "--by", "file", "--boolean", "leak=Does this leak?"],
        {
          cwd: process.cwd(),
          stdout: () => undefined,
          stderr: (text: string) => stderr.push(text),
        },
      );
      expect(code).toBe(1);
      expect(stderr.join("")).toContain(MISSING_API_KEY_MESSAGE);
    } finally {
      if (saved !== undefined) process.env["TYPESAFE_API_KEY"] = saved;
    }
  });
});
