export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  reasoning_effort?: "low" | "medium" | "high";
}

export interface ProviderResult {
  content: string;
  finishReason: string;
  inputTokens: number;
  /** Billed output, including any thinking tokens. */
  outputTokens: number;
  reasoningTokens?: number;
}

export interface Provider {
  readonly name: string;
  complete(req: ChatRequest, model: string, signal: AbortSignal): Promise<ProviderResult>;
}

/**
 * `retryable` means "another deployment might succeed": timeouts, 429, 5xx, and
 * deployment-level 401/403/404. Request-level errors (400/413/422) would fail
 * identically everywhere, so falling back only burns latency.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function classifyHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 || [401, 403, 404].includes(status);
}

export async function fetchJson(
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    const e = err as Error;
    const kind = e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : "network error";
    throw new ProviderError(`${provider} ${kind}: ${e.message}`, true);
  }
  const text = await res.text();
  if (!res.ok) {
    // Gemini reports a bad API key as 400 INVALID_ARGUMENT; that's our config
    // problem, not the caller's request, so it must not be surfaced as a 400.
    const badCredential = res.status === 400 && /api[ _-]?key/i.test(text);
    // Upstream bodies can echo request details; keep only a short prefix.
    throw new ProviderError(
      `${provider} HTTP ${res.status}: ${text.slice(0, 300)}`,
      badCredential || classifyHttpStatus(res.status),
      res.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${provider} returned non-JSON body`, true, res.status);
  }
}
