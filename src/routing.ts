import type { Config } from "./config.js";
import { estimateInputTokens, priceFor, costMicros } from "./pricing.js";
import { MockProvider } from "./providers/mock.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatProvider } from "./providers/openai-compat.js";
import type { ChatMessage, ChatRequest, Provider } from "./providers/types.js";

export type Tier = "capable" | "cheap" | "local" | "mock";

export interface Deployment {
  name: string;
  tier: Tier;
  provider: Provider;
  model: string;
}

export function buildDeployments(cfg: Config): Deployment[] {
  const out: Deployment[] = [];
  if (cfg.GEMINI_API_KEY) {
    const gemini = new OpenAICompatProvider("gemini", cfg.GEMINI_API_KEY, cfg.GEMINI_BASE_URL);
    out.push({ name: "gemini-capable", tier: "capable", provider: gemini, model: cfg.GEMINI_CAPABLE_MODEL });
    if (cfg.GEMINI_CAPABLE_FALLBACK_MODEL) {
      out.push({ name: "gemini-capable-2", tier: "capable", provider: gemini, model: cfg.GEMINI_CAPABLE_FALLBACK_MODEL });
    }
    out.push({ name: "gemini-cheap", tier: "cheap", provider: gemini, model: cfg.GEMINI_CHEAP_MODEL });
  }
  if (cfg.OLLAMA_URL) {
    const ollama = new OllamaProvider(cfg.OLLAMA_URL, cfg.OLLAMA_NUM_CTX_MAX);
    out.push({ name: "ollama-local", tier: "local", provider: ollama, model: cfg.OLLAMA_MODEL });
  }
  if (cfg.enableMock) {
    out.push({ name: "mock", tier: "mock", provider: new MockProvider(), model: "mock-echo" });
  }
  if (out.length === 0) {
    throw new Error("No providers configured: set GEMINI_API_KEY, OLLAMA_URL, or ENABLE_MOCK_PROVIDER=true");
  }
  return out;
}

// Fallback order per tier. Mock is always last so it only answers when every real
// deployment is down (and it only exists at all outside production by default).
const FALLBACK_ORDER: Record<Tier, Tier[]> = {
  capable: ["capable", "cheap", "mock"],
  cheap: ["cheap", "capable", "mock"],
  local: ["local", "cheap", "capable", "mock"],
  mock: ["mock"],
};

export interface Route {
  chain: Deployment[];
  reason: string;
}

const CLASSIFY_HINT = /\b(classify|classification|categori[sz]e|label|sentiment|intent|yes or no|one word)\b/i;
const CODE_HINT = /```|\bfunction\b|\bstack trace\b|\bdebug\b|\brefactor\b|\bprove\b|step[- ]by[- ]step/i;

/**
 * Picks a tier for model="auto". Ordered, explainable rules rather than a learned
 * policy: every decision is returned as `reason` and logged, so a bad route is
 * debuggable from the usage table alone.
 */
export function chooseTier(
  messages: ChatMessage[],
  maxTokens: number,
  task: string | undefined,
  hasLocal: boolean,
): { tier: Tier; reason: string } {
  const localOrCheap: Tier = hasLocal ? "local" : "cheap";
  if (task === "classification") return { tier: localOrCheap, reason: "task=classification" };
  if (task === "reasoning") return { tier: "capable", reason: "task=reasoning" };

  const inputTokens = estimateInputTokens(messages);
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  if (maxTokens <= 64 && inputTokens <= 1500 && CLASSIFY_HINT.test(system)) {
    return { tier: localOrCheap, reason: "heuristic:classification" };
  }
  if (inputTokens > 4000) return { tier: "capable", reason: "heuristic:long_context" };
  if (messages.some((m) => CODE_HINT.test(m.content))) {
    return { tier: "capable", reason: "heuristic:code_or_reasoning" };
  }
  return { tier: "cheap", reason: "default:cheap" };
}

export class Router {
  private readonly byName: Map<string, Deployment>;

  constructor(readonly deployments: Deployment[]) {
    this.byName = new Map(deployments.map((d) => [d.name, d]));
  }

  private chainFor(tier: Tier): Deployment[] {
    return FALLBACK_ORDER[tier].flatMap((t) => this.deployments.filter((d) => d.tier === t));
  }

  /** Returns null for an unknown model so the caller can 400. */
  route(model: string, req: ChatRequest, task?: string): Route | null {
    const pinned = this.byName.get(model);
    // An explicitly named deployment is never silently substituted.
    if (pinned) return { chain: [pinned], reason: "pinned" };

    if (model === "auto") {
      const { tier, reason } = chooseTier(req.messages, req.max_tokens, task, this.hasTier("local"));
      return { chain: this.chainFor(tier), reason };
    }
    if (model === "capable" || model === "cheap" || model === "local") {
      return this.hasTier(model) ? { chain: this.chainFor(model), reason: `tier=${model}` } : null;
    }
    return null;
  }

  private hasTier(tier: Tier): boolean {
    return this.deployments.some((d) => d.tier === tier);
  }

  /**
   * Worst-case cost across the whole chain: a fallback may land on a pricier
   * deployment, and the reservation has to cover wherever we end up.
   */
  worstCaseCost(chain: Deployment[], req: ChatRequest, usdToInr: number): number {
    const input = estimateInputTokens(req.messages);
    return Math.max(
      0,
      ...chain.map((d) => costMicros(priceFor(d.provider.name, d.model), input, req.max_tokens, usdToInr)),
    );
  }

  listModels(): string[] {
    const tiers = (["capable", "cheap", "local"] as const).filter((t) => this.hasTier(t));
    return ["auto", ...tiers, ...this.byName.keys()];
  }
}

/** Per-deployment breaker: after `threshold` consecutive failures, skip for `cooldownMs`. */
export class CircuitBreaker {
  private failures = new Map<string, number>();
  private openUntil = new Map<string, number>();

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(name: string): boolean {
    return (this.openUntil.get(name) ?? 0) > this.now();
  }

  /** Earliest time any of `names` will accept traffic again. */
  retryAfterMs(names: string[]): number {
    const t = Math.min(...names.map((n) => this.openUntil.get(n) ?? 0));
    return Math.max(0, t - this.now());
  }

  success(name: string) {
    this.failures.delete(name);
    this.openUntil.delete(name);
  }

  failure(name: string) {
    const n = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, n);
    // Once tripped, a single failed half-open probe re-opens it immediately.
    if (n >= this.threshold) this.openUntil.set(name, this.now() + this.cooldownMs);
  }

  snapshot() {
    return Object.fromEntries(
      [...this.failures.keys()].map((k) => [k, { failures: this.failures.get(k), open: this.isOpen(k) }]),
    );
  }
}
