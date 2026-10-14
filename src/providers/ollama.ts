import { estimateInputTokens } from "../pricing.js";
import { fetchJson, ProviderError, type ChatRequest, type Provider } from "./types.js";

/**
 * Uses Ollama's native /api/chat, not its OpenAI-compatible /v1 endpoint, because
 * only the native API accepts `options.num_ctx`. Ollama's default context window
 * is small (2-4K depending on version) and it silently truncates the *start* of
 * the prompt when exceeded, which drops the system prompt first.
 */
export class OllamaProvider implements Provider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly numCtxMax: number,
  ) {}

  async complete(req: ChatRequest, model: string, signal: AbortSignal) {
    const needed = estimateInputTokens(req.messages) + req.max_tokens;
    if (needed > this.numCtxMax) {
      // Retryable: a cloud deployment with a larger window can take it.
      throw new ProviderError(
        `ollama: request needs ~${needed} tokens of context, local cap is ${this.numCtxMax}`,
        true,
      );
    }
    // Round up to a power of two so the model isn't reloaded for every distinct size.
    const numCtx = Math.min(this.numCtxMax, Math.max(2048, 2 ** Math.ceil(Math.log2(needed))));

    const body = await fetchJson(
      this.name,
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: false,
          keep_alive: "10m",
          options: {
            num_ctx: numCtx,
            num_predict: req.max_tokens,
            temperature: req.temperature,
            top_p: req.top_p,
            stop: req.stop,
          },
        }),
      },
      signal,
    );
    if (typeof body?.message?.content !== "string") {
      throw new ProviderError("ollama returned no message", true);
    }
    return {
      content: body.message.content,
      finishReason: body.done_reason === "length" ? "length" : "stop",
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
    };
  }
}
