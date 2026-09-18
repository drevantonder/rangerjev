import { TypeSafeClient } from "@typesafe-ai/sdk";
const DEFAULT_MODEL = "jev-1.13.0";
function toNumber(value) {
    return typeof value === "number" ? value : 0;
}
export class RangerEvaluator {
    model;
    endpoint;
    client;
    constructor() {
        this.endpoint = process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai";
        this.model = process.env.RANGERJEV_MODEL?.trim() || DEFAULT_MODEL;
    }
    async ask(state, questions) {
        const client = (this.client ??= new TypeSafeClient({
            baseURL: this.endpoint,
            defaultModel: this.model,
        }));
        const response = await client.systemOne({ state, questions, model: this.model });
        const answers = (response.answers ?? {});
        const inputTokens = toNumber(response.usage?.input_tokens);
        const outputTokens = toNumber(response.usage?.output_tokens);
        return {
            answers: { ...answers },
            usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        };
    }
}
//# sourceMappingURL=evaluator.js.map