import type { FastifyBaseLogger } from "fastify";
import type { CircuitBreaker, Deployment } from "./routing.js";
import { ProviderError, type ChatRequest, type ProviderResult } from "./providers/types.js";

export interface Attempt {
  deployment: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface ExecuteSuccess {
  ok: true;
  deployment: Deployment;
  result: ProviderResult;
  attempts: Attempt[];
}

export interface ExecuteFailure {
  ok: false;
  kind: "all_failed" | "non_retryable" | "circuit_open" | "deadline";
  status?: number;
  retryAfterMs?: number;
  attempts: Attempt[];
  message: string;
}

/**
 * Fallback policy: walk the chain in order, one attempt per deployment, no
 * same-deployment retry. Rationale: the common failures (429 quota, 5xx outage,
 * timeout) are not fixed by retrying the same target a few hundred ms later, and
 * every retry stacks latency onto the caller. Moving to different capacity is the
 * retry. A request-level error (400) stops the walk immediately.
 */
export async function execute(
  chain: Deployment[],
  req: ChatRequest,
  opts: {
    breaker: CircuitBreaker;
    attemptTimeoutMs: number;
    deadlineMs: number;
    log: FastifyBaseLogger;
  },
): Promise<ExecuteSuccess | ExecuteFailure> {
  const started = Date.now();
  const attempts: Attempt[] = [];
  const live = chain.filter((d) => !opts.breaker.isOpen(d.name));

  if (live.length === 0) {
    return {
      ok: false,
      kind: "circuit_open",
      retryAfterMs: opts.breaker.retryAfterMs(chain.map((d) => d.name)),
      attempts,
      message: "all upstream deployments are temporarily unavailable",
    };
  }

  for (const d of live) {
    const remaining = opts.deadlineMs - (Date.now() - started);
    if (remaining <= 250) {
      return { ok: false, kind: "deadline", attempts, message: "gateway deadline exceeded" };
    }
    const t0 = Date.now();
    try {
      const signal = AbortSignal.timeout(Math.min(opts.attemptTimeoutMs, remaining));
      const result = await d.provider.complete(req, d.model, signal);
      opts.breaker.success(d.name);
      attempts.push({ deployment: d.name, ok: true, ms: Date.now() - t0 });
      return { ok: true, deployment: d, result, attempts };
    } catch (err) {
      const pe =
        err instanceof ProviderError ? err : new ProviderError(`${d.name}: ${(err as Error).message}`, true);
      attempts.push({ deployment: d.name, ok: false, error: pe.message, ms: Date.now() - t0 });
      opts.log.warn({ deployment: d.name, retryable: pe.retryable, err: pe.message }, "provider attempt failed");
      if (!pe.retryable) {
        return { ok: false, kind: "non_retryable", status: pe.status, attempts, message: pe.message };
      }
      opts.breaker.failure(d.name);
    }
  }
  return { ok: false, kind: "all_failed", attempts, message: "all upstream deployments failed" };
}
