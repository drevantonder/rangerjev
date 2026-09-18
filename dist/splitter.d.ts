import type { ProjectFile, SplitterFile, SplitterKind, Unit, UnitFinder, UnitSpan } from "./types.js";
export declare const DEFAULT_EXTENSIONS: Set<string>;
export declare function spanOf(source: string, start: number, end: number): UnitSpan;
export declare function collectFiles(cwd: string, patterns: string[], extraExtensions: string[]): Promise<ProjectFile[]>;
export declare function splitFileUnits(files: ProjectFile[]): Unit[];
export declare function splitFunctionUnits(files: ProjectFile[]): Unit[];
export declare function reachableFiles(files: ProjectFile[], entry: string, depth: number): ProjectFile[];
export declare function splitBy(kind: SplitterKind, files: ProjectFile[], options: {
    entry?: string;
    depth?: number;
}): Promise<Unit[]>;
export declare function describeForSplitter(file: ProjectFile): SplitterFile;
export declare function loadUnitFinder(cwd: string, finderPath: string): Promise<UnitFinder>;
export declare function splitCustom(files: ProjectFile[], finder: UnitFinder): Promise<Unit[]>;
export declare function defineUnitFinder(_name: string, finder: UnitFinder): UnitFinder;
