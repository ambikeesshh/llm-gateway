import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { execute } from "./gateway.js";
import { costMicros, inrToMicros, microsToInr, priceFor } from "./pricing.js";
import type { ChatRequest } from "./providers/types.js";
import { CircuitBreaker, Router, type Deployment } from "./routing.js";
import { BudgetExceededError, KeyRevokedError, Store, type ApiKey } from "./store.js";

const ChatBody = z.object({
  model: z.string().default("auto"),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().max(200_000),
      }),
    )
    .min(1)
    .max(200),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  metadata: z.object({ task: z.string().optional() }).passthrough().optional(),
});

const CreateKeyBody = z.object({
  name: z.string().min(1).max(100),
  budget_inr: z.number().nonnegative().max(1_000_000),
});

const PatchKeyBody = z
  .object({
    budget_inr: z.number().nonnegative().max(1_000_000).optional(),
    status: z.enum(["active", "revoked"]).optional(),
  })
  .refine((b) => b.budget_inr !== undefined || b.status !== undefined, "nothing to update");

type ErrType = "invalid_request_error" | "authentication_error" | "budget_exceeded" | "upstream_error" | "server_error";

function sendError(reply: FastifyReply, status: number, type: ErrType, message: string, extra?: object) {
  return reply.code(status).send({ error: { type, message, ...extra } });
}

function presentKey(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    key_prefix: k.key_prefix,
    status: k.status,
    budget_inr: microsToInr(k.budget_micros),
    spent_inr: microsToInr(k.spent_micros),
    reserved_inr: microsToInr(k.reserved_micros),
    remaining_inr: microsToInr(Math.max(0, k.budget_micros - k.spent_micros - k.reserved_micros)),
    created_at: k.created_at,
  };
}

function presentUsage(key: ApiKey, u: Awaited<ReturnType<Store["usage"]>>) {
  const m = (v: unknown) => microsToInr(Number(v ?? 0));
  const t = u.totals as Record<string, number>;
  return {
    key: presentKey(key),
    totals: {
      requests: t.requests,
      ok: t.ok,
      errors: t.errors,
      input_tokens: Number(t.input_tokens),
      output_tokens: Number(t.output_tokens),
      cost_inr: m(t.cost_micros),
    },
    by_model: u.byModel.map((r: any) => ({
      provider: r.provider,
      model: r.model,
      requests: r.requests,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_inr: m(r.cost_micros),
    })),
    recent: u.recent.map((r: any) => ({ ...r, cost_micros: undefined, cost_inr: m(r.cost_micros) })),
  };
}

export interface AppDeps {
  cfg: Config;
  db: Db;
  deployments: Deployment[];
  breaker?: CircuitBreaker;
}

export async function buildApp({ cfg, db, deployments, breaker = new CircuitBreaker() }: AppDeps) {
  const store = new Store(db);
  const router = new Router(deployments);

  const app = Fastify({
    logger:
      cfg.NODE_ENV === "test"
        ? false
        : { level: cfg.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers['x-admin-token']"] },
    bodyLimit: 1_048_576,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    trustProxy: true,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err.validation || err.statusCode === 400) {
      return sendError(reply, 400, "invalid_request_error", err.message);
    }
    if (err.statusCode === 413) return sendError(reply, 413, "invalid_request_error", "request body too large");
    req.log.error({ err }, "unhandled error");
    return sendError(reply, 500, "server_error", "internal error");
  });

  async function authKey(req: FastifyRequest, reply: FastifyReply): Promise<ApiKey | undefined> {
    const h = req.headers.authorization;
    const secret = h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
    if (!secret) {
      sendError(reply, 401, "authentication_error", "missing bearer token");
      return;
    }
    const key = await store.findBySecret(secret);
    if (!key) {
      sendError(reply, 401, "authentication_error", "invalid API key");
      return;
    }
    if (key.status !== "active") {
      sendError(reply, 401, "authentication_error", "API key revoked");
      return;
    }
    return key;
  }

  const adminToken = Buffer.from(cfg.ADMIN_TOKEN);
  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    const h = req.headers.authorization;
    const given = Buffer.from(h?.startsWith("Bearer ") ? h.slice(7).trim() : "");
    if (given.length !== adminToken.length || !timingSafeEqual(given, adminToken)) {
      sendError(reply, 401, "authentication_error", "admin token required");
      return false;
    }
    return true;
  }

  // The dashboard's only script is inline; allow exactly that script by hash and nothing else.
  const page = await readFile(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  app.get("/", async (_req, reply) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", csp)
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .send(page),
  );

  app.get("/healthz", async (_req, reply) => {
    try {
      await store.ping();
      return { status: "ok", deployments: deployments.map((d) => d.name), breakers: breaker.snapshot() };
    } catch {
      return reply.code(503).send({ status: "db_unavailable" });
    }
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: router.listModels().map((id) => ({ id, object: "model", owned_by: "gateway" })),
  }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const key = await authKey(req, reply);
    if (!key) return reply;

    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return sendError(reply, 400, "invalid_request_error", msg);
    }
    const body = parsed.data;
    if (body.stream) {
      return sendError(reply, 400, "invalid_request_error", "stream=true is not supported by this gateway");
    }

    const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? cfg.DEFAULT_MAX_TOKENS;
    if (maxTokens > cfg.MAX_TOKENS_CAP) {
      return sendError(reply, 400, "invalid_request_error", `max_tokens must be <= ${cfg.MAX_TOKENS_CAP}`);
    }
    const chatReq: ChatRequest = {
      messages: body.messages,
      max_tokens: maxTokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: typeof body.stop === "string" ? [body.stop] : body.stop,
      reasoning_effort: body.reasoning_effort ?? cfg.DEFAULT_REASONING_EFFORT,
    };

    const route = router.route(body.model, chatReq, body.metadata?.task);
    if (!route) {
      return sendError(reply, 400, "invalid_request_error", `unknown model '${body.model}'`, {
        available: router.listModels(),
      });
    }

    const reserved = router.worstCaseCost(route.chain, chatReq, cfg.USD_TO_INR);
    const eventId = req.id;
    try {
      await store.reserve(key.id, reserved, {
        id: eventId,
        requestedModel: body.model,
        routeReason: route.reason,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return sendError(reply, 402, "budget_exceeded", "key budget exhausted for this request", {
          remaining_inr: microsToInr(err.remainingMicros),
          required_inr: microsToInr(err.requiredMicros),
        });
      }
      if (err instanceof KeyRevokedError) return sendError(reply, 401, "authentication_error", "API key revoked");
      throw err;
    }

    const started = Date.now();
    const outcome = await execute(route.chain, chatReq, {
      breaker,
      attemptTimeoutMs: cfg.PROVIDER_TIMEOUT_MS,
      deadlineMs: cfg.REQUEST_DEADLINE_MS,
      log: req.log,
    });
    const latencyMs = Date.now() - started;

    if (!outcome.ok) {
      await store.settle(eventId, key.id, {
        status: "error",
        attempts: outcome.attempts.length,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        latencyMs,
        error: `${outcome.kind}: ${outcome.message} | ${outcome.attempts.map((a) => a.error).join(" | ")}`,
      });
      const details = { attempts: outcome.attempts.map(({ deployment, error, ms }) => ({ deployment, error, ms })) };
      switch (outcome.kind) {
        case "non_retryable":
          return sendError(reply, 400, "invalid_request_error", `upstream rejected request: ${outcome.message}`, details);
        case "circuit_open":
          reply.header("retry-after", Math.ceil((outcome.retryAfterMs ?? 0) / 1000));
          return sendError(reply, 503, "upstream_error", outcome.message, details);
        case "deadline":
          return sendError(reply, 504, "upstream_error", outcome.message, details);
        default:
          return sendError(reply, 502, "upstream_error", outcome.message, details);
      }
    }

    const { deployment: d, result } = outcome;
    const cost = costMicros(priceFor(d.provider.name, d.model), result.inputTokens, result.outputTokens, cfg.USD_TO_INR);
    // Synchronous on purpose: the response waits for the spend to be durable.
    await store.settle(eventId, key.id, {
      status: "ok",
      provider: d.provider.name,
      model: d.model,
      attempts: outcome.attempts.length,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros: cost,
      latencyMs,
    });

    reply.headers({
      "x-gateway-deployment": d.name,
      "x-gateway-route-reason": route.reason,
      "x-gateway-attempts": String(outcome.attempts.length),
      "x-gateway-cost-inr": String(microsToInr(cost)),
    });
    return {
      id: `chatcmpl-${eventId}`,
      object: "chat.completion",
      created: Math.floor(started / 1000),
      model: d.model,
      choices: [
        { index: 0, message: { role: "assistant", content: result.content }, finish_reason: result.finishReason },
      ],
      usage: {
        prompt_tokens: result.inputTokens,
        completion_tokens: result.outputTokens,
        total_tokens: result.inputTokens + result.outputTokens,
        completion_tokens_details: { reasoning_tokens: result.reasoningTokens ?? 0 },
      },
    };
  });

  app.get<{ Querystring: { since?: string } }>("/v1/usage", async (req, reply) => {
    const key = await authKey(req, reply);
    if (!key) return reply;
    return presentUsage(key, await store.usage(key.id, req.query.since));
  });

  app.post("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = CreateKeyBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request_error", parsed.error.issues[0]!.message);
    const { key, secret } = await store.createKey(parsed.data.name, inrToMicros(parsed.data.budget_inr));
    return reply.code(201).send({ ...presentKey(key), api_key: secret, note: "store this key now; it is not shown again" });
  });

  app.get("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { data: (await store.listKeys()).map(presentKey) };
  });

  app.patch<{ Params: { id: string } }>("/admin/keys/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = PatchKeyBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request_error", parsed.error.issues[0]!.message);
    const key = await store.updateKey(req.params.id, {
      budgetMicros: parsed.data.budget_inr === undefined ? undefined : inrToMicros(parsed.data.budget_inr),
      status: parsed.data.status,
    });
    if (!key) return sendError(reply, 404, "invalid_request_error", "key not found");
    return presentKey(key);
  });

  app.get<{ Querystring: { key_id?: string; since?: string } }>("/admin/usage", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!req.query.key_id) return sendError(reply, 400, "invalid_request_error", "key_id is required");
    const key = await store.getKey(req.query.key_id);
    if (!key) return sendError(reply, 404, "invalid_request_error", "key not found");
    return presentUsage(key, await store.usage(key.id, req.query.since));
  });

  return { app, store };
}
