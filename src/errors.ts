/** Machine-readable failure codes. Every user-facing failure carries one in
 *  brackets ahead of the human sentence, so agents match on the code while
 *  humans read the text. Text after the bracket stays stable: existing
 *  substring matches keep working. */
export function rangerError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}
