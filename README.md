# LLM Gateway

A small gateway in front of Gemini. It gives out its own API keys, gives each key a budget in rupees and actually enforces it, logs every request's tokens and cost, and falls back to another model when one fails. It speaks the OpenAI format, so the OpenAI SDK works by changing `base_url`.

The reasoning is in [DECISIONS.md](./DECISIONS.md); start there. How I used AI is in [AI-LOG.md](./AI-LOG.md).

**Live:** https://llm-gateway-mg5t.onrender.com (Render free tier in Singapore, with Neon Postgres). If nobody has used it for 15 minutes, the first request takes about a minute while it wakes up.

## Try it

The reviewer key (₹10 budget) came with the submission. Either open the live URL and paste the key into the page, or use curl:

```bash
B=https://llm-gateway-mg5t.onrender.com
GW_KEY=gw_...   # reviewer key

curl -si $B/v1/chat/completions \
  -H "authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","max_tokens":1024,"messages":[{"role":"user","content":"Explain idempotency in one paragraph."}]}'

curl -s $B/v1/usage -H "authorization: Bearer $GW_KEY"   # how much has this key spent?
```

Keep `max_tokens` at 1024 or more. On Gemini 3, thinking tokens come out of `max_tokens`, so a small cap can get used up before any text is written.

With the admin token:

```bash
# new key with a ₹5 budget (the plaintext key is returned once, never stored)
curl -s -X POST $B/admin/keys \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"demo","budget_inr":5}'

# how much has key X spent?
curl -s "$B/admin/usage?key_id=key_xxx" -H "authorization: Bearer $ADMIN_TOKEN"
```

With the OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="https://llm-gateway-mg5t.onrender.com/v1", api_key="gw_...")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hi"}])
```

## API

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/` | key typed into the page | Small dashboard: budget meter, spend, per-model breakdown, recent requests, and a prompt box |
| POST | `/v1/chat/completions` | virtual key | Chat completion (non-streaming) |
| GET | `/v1/models` | none | Models and tiers it accepts |
| GET | `/v1/usage?since=ISO` | virtual key | Your own spend, totals, per-model breakdown, and last 20 requests |
| POST | `/admin/keys` | admin | Create a key: `{name, budget_inr}` |
| GET | `/admin/keys` | admin | List keys with spent, reserved and remaining |
| PATCH | `/admin/keys/:id` | admin | Change a key: `{budget_inr?, status?: "active"\|"revoked"}` |
| GET | `/admin/usage?key_id=` | admin | Spend for any key |
| GET | `/healthz` | none | DB ping, deployments, breaker state |

`model` can be `auto` (the router picks), `cheap`, `capable`, `local` (if Ollama is set up), or a specific deployment like `gemini-capable`. Sending `"metadata": {"task": "classification"}` routes the request to the cheapest tier.

Every response has `x-gateway-deployment`, `x-gateway-route-reason`, `x-gateway-attempts`, `x-gateway-cost-inr` and `x-request-id` headers.

Errors follow the OpenAI shape, `{"error": {"type", "message", ...}}`:

| Status | Meaning |
|---|---|
| 400 | Bad request |
| 401 | Bad or revoked key |
| **402** | **Over budget** |
| 502 | Every provider failed |
| 503 | Every circuit breaker is open (with `Retry-After`) |
| 504 | Deadline hit |

## Run it locally

```bash
npm install
cp .env.example .env    # ADMIN_TOKEN required; GEMINI_API_KEY optional (mock provider otherwise)
npm run dev             # http://localhost:8080
npm test                # 22 tests: auth, budgets, concurrency, fallback, breaker, sweeper, router, Gemini billing
scripts/smoke.sh http://localhost:8080   # end-to-end check (needs ADMIN_TOKEN exported)
```

With no `DATABASE_URL`, the gateway runs an embedded Postgres (PGlite) in `./.data`, so there's nothing to install. With no `GEMINI_API_KEY`, only the mock provider runs. To trigger failures, put `[mock:fail]` or `[mock:slow]` in a message.

To run the tests against real Postgres, set `TEST_DATABASE_URL`. Use a separate database: the tests truncate tables.

For a local model, run `ollama pull qwen2.5:1.5b` and set `OLLAMA_URL=http://localhost:11434`.

## How it's deployed, and where secrets live

Render web service defined by `render.yaml` (Blueprint), backed by Neon Postgres over the pooled endpoint. Pushes to `main` auto-deploy; Render gates traffic on `/healthz`, which pings the database.

| Variable | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon | Pooled connection string; TLS is upgraded to `verify-full` at connect time |
| `GEMINI_API_KEY` | Google AI Studio | `sync: false`, so it's never stored in the repo |
| `ADMIN_TOKEN` | Render `generateValue` | 256-bit, guards `/admin/*` |
| `NODE_ENV` | `render.yaml` | `production` disables the mock provider |

The schema is idempotent and applied on boot, so there's no separate migration step. The 28 s request deadline sits under Render's 30 s shutdown grace, so in-flight requests settle before a redeploy kills the process.

## Layout

```
src/
  server.ts        boot, migrations, sweeper, graceful shutdown
  app.ts           routes, auth, the request lifecycle
  store.ts         keys, reserve/settle, usage queries
  gateway.ts       walks the fallback chain with timeouts
  routing.ts       deployments, router, circuit breaker
  pricing.ts       ₹ pricing (dated) + token estimate
  providers/       openai-compat (Gemini), ollama (native API for num_ctx), mock
public/index.html  the dashboard: one file, no framework, strict CSP
schema.sql         two tables, money as BIGINT micro-rupees
test/              vitest, embedded Postgres by default
scripts/           smoke test, Gemini probes, DB check
```
