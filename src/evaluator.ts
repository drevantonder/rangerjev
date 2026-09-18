import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue, Questions } from "@typesafe-ai/sdk";

const DEFAULT_MODEL = "jev-1.13.0";

export { DEFAULT_MODEL };

export interface BatchAnswer {
  type: string;
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
}

export interface BatchResult {
  answers: Record<string, BatchAnswer>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export type AskState = { [key: string]: JsonValue };

export const MISSING_API_KEY_MESSAGE =
  "[RANGERJEV_NO_API_KEY] no Typesafe API key found. Set TYPESAFE_API_KEY in the environment.";

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env["TYPESAFE_API_KEY"];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class RangerEvaluator {
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private client: TypeSafeClient | undefined;

  constructor(apiKey?: string) {
    this.endpoint = process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai";
    this.model = process.env.RANGERJEV_MODEL?.trim() || DEFAULT_MODEL;
    this.apiKey = apiKey ?? resolveApiKey();
  }

  async ask(state: AskState, questions: Questions): Promise<BatchResult> {
    const client = (this.client ??= new TypeSafeClient({
      baseURL: this.endpoint,
      apiKey: this.apiKey,
      defaultModel: this.model,
    }));
    const response = await client.systemOne({ state, questions, model: this.model });
    const answers = (response.answers ?? {}) as Record<string, BatchAnswer>;
    const inputTokens = toNumber(response.usage?.input_tokens);
    const outputTokens = toNumber(response.usage?.output_tokens);
    return {
      answers: { ...answers },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }
}
