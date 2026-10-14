import { estimateInputTokens } from "../pricing.js";
import { ProviderError, type ChatRequest, type Provider } from "./types.js";

/**
 * Deterministic stand-in for local dev and tests. Magic strings in the last user
 * message let you exercise failure paths end to end (`<name>` is this provider's name):
 *   [<name>:fail]  -> retryable 503
 *   [<name>:slow]  -> hangs until the attempt times out
 *   [mock:fail-all] -> every mock fails
 *   [mock:400]     -> non-retryable 400
 */
export class MockProvider implements Provider {
  constructor(readonly name = "mock") {}

  async complete(req: ChatRequest, _model: string, signal: AbortSignal) {
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (last.includes(`[${this.name}:fail]`) || last.includes("[mock:fail-all]")) {
      throw new ProviderError(`${this.name} HTTP 503: simulated outage`, true, 503);
    }
    if (last.includes("[mock:400]")) {
      throw new ProviderError(`${this.name} HTTP 400: simulated bad request`, false, 400);
    }
    if (last.includes(`[${this.name}:slow]`)) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new ProviderError(`${this.name} timeout`, true)),
        );
      });
    }
    const content = `[${this.name}] echo: ${last.slice(0, 200)}`;
    const outputTokens = Math.min(req.max_tokens, Math.ceil(content.length / 4));
    return {
      content,
      finishReason: "stop",
      inputTokens: estimateInputTokens(req.messages),
      outputTokens,
    };
  }
}
