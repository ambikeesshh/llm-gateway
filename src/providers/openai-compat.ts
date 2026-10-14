import { fetchJson, ProviderError, type ChatRequest, type Provider } from "./types.js";

/**
 * Any provider exposing OpenAI's /chat/completions shape. Gemini does
 * (generativelanguage.googleapis.com/v1beta/openai), as do Groq, OpenRouter,
 * Together and vLLM, so a second vendor is configuration, not code.
 */
export class OpenAICompatProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async complete(req: ChatRequest, model: string, signal: AbortSignal) {
    const body = await fetchJson(
      this.name,
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          max_tokens: req.max_tokens,
          temperature: req.temperature,
          top_p: req.top_p,
          stop: req.stop,
          reasoning_effort: req.reasoning_effort,
        }),
      },
      signal,
    );
    const choice = body?.choices?.[0];
    if (!choice) throw new ProviderError(`${this.name} returned no choices`, true);

    // Gemini's completion_tokens excludes thinking tokens, which are billed as output;
    // they only show up in total_tokens. (OpenAI's own completion_tokens includes them.)
    const input = body.usage?.prompt_tokens ?? 0;
    const visible = body.usage?.completion_tokens ?? 0;
    const output = Math.max(visible, (body.usage?.total_tokens ?? 0) - input);
    return {
      // Thinking can consume all of max_tokens, leaving no text: a valid, billed,
      // length-truncated answer rather than a provider failure.
      content: typeof choice.message?.content === "string" ? choice.message.content : "",
      finishReason: choice.finish_reason ?? "stop",
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: output - visible,
    };
  }
}
