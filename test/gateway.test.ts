import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPgDb, createPgliteDb, migrate, type Db } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { CircuitBreaker, chooseTier, type Deployment } from "../src/routing.js";

const ADMIN = "test-admin-token-0123456789abcdef";
const cfg = loadConfig({
  NODE_ENV: "test",
  ADMIN_TOKEN: ADMIN,
  PROVIDER_TIMEOUT_MS: "300",
  REQUEST_DEADLINE_MS: "2000",
  DEFAULT_MAX_TOKENS: "100",
});

// Mock providers priced as real Gemini models, so budgets and costs are non-zero.
const deployments: Deployment[] = [
  { name: "primary", tier: "capable", provider: new MockProvider("primary"), model: "gemini-2.5-flash" },
  { name: "secondary", tier: "cheap", provider: new MockProvider("secondary"), model: "gemini-2.5-flash-lite" },
];

// Set TEST_DATABASE_URL to run the same suite against real Postgres (true row-lock concurrency).
const db: Db = process.env.TEST_DATABASE_URL
  ? await createPgDb(process.env.TEST_DATABASE_URL)
  : await createPgliteDb();
await migrate(db);
afterAll(() => db.close());

let breaker: CircuitBreaker;
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  await db.query("TRUNCATE usage_events, api_keys");
  breaker = new CircuitBreaker(3, 30_000);
  ctx = await buildApp({ cfg, db, deployments, breaker });
});

async function newKey(budgetInr: number) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/keys",
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { name: "t", budget_inr: budgetInr },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; api_key: string };
}

function chat(key: string, content: string, extra: object = {}) {
  return ctx.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: { model: "capable", messages: [{ role: "user", content }], ...extra },
  });
}

async function keyRow(id: string) {
  const [k] = await db.query<any>("SELECT * FROM api_keys WHERE id = $1", [id]);
  return k;
}

describe("auth", () => {
  it("rejects missing, unknown and revoked keys", async () => {
    expect((await chat("", "hi")).statusCode).toBe(401);
    expect((await chat("gw_nope", "hi")).statusCode).toBe(401);

    const k = await newKey(10);
    await ctx.app.inject({
      method: "PATCH",
      url: `/admin/keys/${k.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { status: "revoked" },
    });
    expect((await chat(k.api_key, "hi")).statusCode).toBe(401);
  });

  it("admin routes require the admin token, not a virtual key", async () => {
    const k = await newKey(10);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: { authorization: `Bearer ${k.api_key}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("never stores the plaintext key", async () => {
    const k = await newKey(10);
    const row = await keyRow(k.id);
    expect(JSON.stringify(row)).not.toContain(k.api_key);
  });
});

describe("proxy + usage logging", () => {
  it("returns an OpenAI-shaped completion and records spend", async () => {
    const k = await newKey(10);
    const res = await chat(k.api_key, "hello there");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toContain("hello there");
    expect(res.headers["x-gateway-deployment"]).toBe("primary");

    const usage = await ctx.app.inject({
      method: "GET",
      url: `/admin/usage?key_id=${k.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const u = usage.json();
    expect(u.totals.requests).toBe(1);
    expect(u.totals.input_tokens).toBe(body.usage.prompt_tokens);
    expect(u.totals.cost_inr).toBeGreaterThan(0);
    expect(u.totals.cost_inr).toBeCloseTo(Number(res.headers["x-gateway-cost-inr"]), 6);
    expect(u.key.spent_inr).toBeCloseTo(u.totals.cost_inr, 6);
    expect(u.key.reserved_inr).toBe(0);
  });

  it("rejects stream=true and oversized max_tokens explicitly", async () => {
    const k = await newKey(10);
    expect((await chat(k.api_key, "x", { stream: true })).statusCode).toBe(400);
    expect((await chat(k.api_key, "x", { max_tokens: 999_999 })).statusCode).toBe(400);
    expect((await chat(k.api_key, "x", { model: "gpt-9" })).statusCode).toBe(400);
  });
});

describe("budget enforcement", () => {
  it("blocks with 402 once the budget cannot cover the worst case", async () => {
    const k = await newKey(0.0001);
    const res = await chat(k.api_key, "hello");
    expect(res.statusCode).toBe(402);
    expect(res.json().error.type).toBe("budget_exceeded");
    expect((await keyRow(k.id)).spent_micros).toBe(0);
  });

  it("never lets concurrent requests overspend a near-exhausted key", async () => {
    // Each request reserves ~₹0.026 and actually spends ~₹0.016, so ₹0.07 covers at most 4.
    const k = await newKey(0.07);
    const prompt = "x".repeat(400);
    const results = await Promise.all(Array.from({ length: 25 }, () => chat(k.api_key, prompt)));
    const codes = results.map((r) => r.statusCode);
    const ok = codes.filter((c) => c === 200).length;

    expect(codes.every((c) => c === 200 || c === 402)).toBe(true);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(4);

    const row = await keyRow(k.id);
    expect(row.reserved_micros).toBe(0);
    expect(row.spent_micros).toBeLessThanOrEqual(row.budget_micros);
    const [{ total }] = await db.query<any>(
      "SELECT COALESCE(SUM(cost_micros),0)::bigint AS total FROM usage_events WHERE key_id = $1",
      [k.id],
    );
    expect(Number(total)).toBe(row.spent_micros);
  });
});

describe("fallback + resilience", () => {
  it("falls back to the next deployment on a retryable error", async () => {
    const k = await newKey(10);
    const res = await chat(k.api_key, "[primary:fail] hi");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-deployment"]).toBe("secondary");
    expect(res.headers["x-gateway-attempts"]).toBe("2");
  });

  it("falls back on timeout", async () => {
    const k = await newKey(10);
    const res = await chat(k.api_key, "[primary:slow] hi");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-deployment"]).toBe("secondary");
  });

  it("does not fall back on a request-level 400, and releases the reservation", async () => {
    const k = await newKey(10);
    const res = await chat(k.api_key, "[mock:400] hi");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.attempts).toHaveLength(1);
    const row = await keyRow(k.id);
    expect(row.reserved_micros).toBe(0);
    expect(row.spent_micros).toBe(0);
  });

  it("returns 502 when every deployment fails, charging nothing", async () => {
    const k = await newKey(10);
    const res = await chat(k.api_key, "[mock:fail-all] hi");
    expect(res.statusCode).toBe(502);
    const row = await keyRow(k.id);
    expect(row.reserved_micros).toBe(0);
    expect(row.spent_micros).toBe(0);
    const [ev] = await db.query<any>("SELECT status, attempts FROM usage_events WHERE key_id = $1", [k.id]);
    expect(ev).toMatchObject({ status: "error", attempts: 2 });
  });

  it("opens the circuit after repeated failures and skips the dead deployment", async () => {
    const k = await newKey(10);
    for (let i = 0; i < 3; i++) await chat(k.api_key, "[primary:fail] hi");
    const res = await chat(k.api_key, "healthy request");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-deployment"]).toBe("secondary");
    expect(res.headers["x-gateway-attempts"]).toBe("1");
  });

  it("sweeps reservations orphaned by a crash", async () => {
    const k = await newKey(10);
    await ctx.store.reserve(k.id, 5_000, { id: "orphan", requestedModel: "auto", routeReason: "test" });
    await db.query("UPDATE usage_events SET created_at = now() - interval '1 hour' WHERE id = 'orphan'");
    expect((await keyRow(k.id)).reserved_micros).toBe(5_000);

    expect(await ctx.store.sweepExpired(60_000)).toBe(1);
    expect((await keyRow(k.id)).reserved_micros).toBe(0);
  });
});

describe("dashboard page", () => {
  it("serves the page with a CSP that allows only its own inline script", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  });
});

describe("router", () => {
  const user = (content: string) => [{ role: "user" as const, content }];

  it("sends classification to local when available, else cheap", () => {
    const msgs = [{ role: "system" as const, content: "Classify the sentiment as positive or negative." }, ...user("I love it")];
    expect(chooseTier(msgs, 5, undefined, true)).toMatchObject({ tier: "local" });
    expect(chooseTier(msgs, 5, undefined, false)).toMatchObject({ tier: "cheap" });
    expect(chooseTier(user("x"), 500, "classification", true)).toMatchObject({ tier: "local" });
  });

  it("sends code and long context to capable, the rest to cheap", () => {
    expect(chooseTier(user("```js\nfoo()\n``` why does this throw?"), 500, undefined, true).tier).toBe("capable");
    expect(chooseTier(user("a".repeat(20_000)), 500, undefined, true).tier).toBe("capable");
    expect(chooseTier(user("what's the capital of France?"), 500, undefined, true).tier).toBe("cheap");
  });
});
