#!/usr/bin/env node
export declare function runCli(args: string[], dependencies?: {
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}): Promise<number>;
