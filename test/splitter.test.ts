import { describe, expect, it } from "vitest";
import { reachableFiles, splitFileUnits, splitFunctionUnits } from "../src/splitter.js";

describe("splitFileUnits", () => {
  it("makes one unit per file with full spans", () => {
    const units = splitFileUnits([
      { path: "a.ts", source: "const x = 1;" },
      { path: "b.ts", source: "" },
    ]);
    expect(units.map((unit) => unit.id)).toEqual(["a.ts#file", "b.ts#file"]);
    expect(units[0]?.span.startLine).toBe(1);
    expect(units[0]?.span.endLine).toBe(1);
  });
});

describe("splitFunctionUnits", () => {
  it("splits each function into its own unit", () => {
    const units = splitFunctionUnits([
      { path: "a.ts", source: "export function one() { return 1; }\nexport function two() { return 2; }\n" },
    ]);
    expect(units).toHaveLength(2);
    expect(units[0]?.id).toBe("a.ts#fn0");
    expect(units[0]?.source).toContain("function one");
    expect(units[1]?.source).toContain("function two");
  });

  it("falls back to a file unit when nothing is a function", () => {
    const units = splitFunctionUnits([{ path: "a.ts", source: "export const x = 1;\n" }]);
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe("a.ts#file");
  });

  it("falls back to a file unit on parse errors", () => {
    const units = splitFunctionUnits([{ path: "a.ts", source: "function broken( {\n" }]);
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe("a.ts#file");
  });
});

describe("reachableFiles", () => {
  const files = [
    { path: "src/index.ts", source: "import { db } from './db.js';\n" },
    { path: "src/db.ts", source: "import { util } from './util.js';\nexport const db = 1;\n" },
    { path: "src/util.ts", source: "export const util = 1;\n" },
    { path: "src/other.ts", source: "export const other = 1;\n" },
  ];

  it("walks relative imports to the given depth", () => {
    expect(reachableFiles(files, "src/index.ts", 1).map((file) => file.path)).toEqual([
      "src/db.ts",
      "src/index.ts",
    ]);
    expect(reachableFiles(files, "src/index.ts", 5).map((file) => file.path)).toEqual([
      "src/db.ts",
      "src/index.ts",
      "src/util.ts",
    ]);
  });

  it("rejects an entry outside the scope", () => {
    expect(() => reachableFiles(files, "src/missing.ts", 3)).toThrow("entry not in scope");
  });
});
