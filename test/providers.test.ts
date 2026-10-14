import { afterEach, describe, expect, it, vi } from "vitest";
import { priceFor } from "../src/pricing.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { ProviderError } from "../src/providers/types.js";

const provider = new OpenAICompatProvider("gemini", "test-key", "https://example.test");
const req = { messages: [{ role: "user" as const, content: "hi" }], max_tokens: 200 };

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider (Gemini shapes)", () => {
  it("bills thinking tokens, which Gemini only reports inside total_tokens", async () => {
    // Shape recorded from gemini-3.8-flash: 8 visible tokens, 188 thinking tokens.
    stubFetch(200, {
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "A budget" } }],
      usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 207 },
    });
    const r = await provider.complete(req, "gemini-3.8-flash", AbortSignal.timeout(1000));
    expect(r.outputTokens).toBe(196);
    expect(r.reasoningTokens).toBe(188);
  });

  it("treats a reply whose max_tokens went entirely to thinking as a valid empty answer", async () => {
    stubFetch(200, {
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant" } }],
      usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 38 },
    });
    const r = await provider.complete(req, "gemini-3.8-flash", AbortSignal.timeout(1000));
    expect(r).toMatchObject({ content: "", finishReason: "length", outputTokens: 27 });
  });

  it("treats Gemini's 400-for-bad-API-key as a deployment fault, not a caller error", async () => {
    stubFetch(400, { error: { message: "API key not valid. Please pass a valid API key." } });
    const err = await provider.complete(req, "m", AbortSignal.timeout(1000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("does not fall back on a genuine request-level 400", async () => {
    stubFetch(400, { error: { message: "Invalid value for reasoning_effort" } });
    const err = await provider.complete(req, "m", AbortSignal.timeout(1000)).catch((e) => e);
    expect(err.retryable).toBe(false);
  });
});

describe("pricing", () => {
  it("applies Gemini 3.8 Flash's scheduled 2027 price change", () => {
    expect(priceFor("gemini", "gemini-3.8-flash", new Date("2026-12-31T23:00:00Z")).outputPerM).toBe(3.75);
    expect(priceFor("gemini", "gemini-3.8-flash", new Date("2027-01-01T00:00:00Z")).outputPerM).toBe(7.5);
  });

  it("prices unknown models high and local models at zero", () => {
    expect(priceFor("gemini", "gemini-flash-latest").outputPerM).toBeGreaterThanOrEqual(7.5);
    expect(priceFor("ollama", "qwen2.5:1.5b").outputPerM).toBe(0);
  });
});
