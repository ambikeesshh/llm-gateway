import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  budget_micros: number;
  spent_micros: number;
  reserved_micros: number;
  status: "active" | "revoked";
  created_at: string;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly remainingMicros: number,
    readonly requiredMicros: number,
  ) {
    super("budget exceeded");
  }
}

export class KeyRevokedError extends Error {}

// Virtual keys carry 256 bits of entropy, so a fast unsalted hash is sufficient:
// there is nothing to brute-force, and lookups stay a single indexed equality.
export const hashKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

const KEY_COLUMNS =
  "id, name, key_prefix, budget_micros, spent_micros, reserved_micros, status, created_at";

export interface Settlement {
  status: "ok" | "error";
  provider?: string;
  model?: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  error?: string;
}

export class Store {
  constructor(private readonly db: Db) {}

  async createKey(name: string, budgetMicros: number): Promise<{ key: ApiKey; secret: string }> {
    const secret = `gw_${randomBytes(32).toString("base64url")}`;
    const id = `key_${randomBytes(6).toString("hex")}`;
    const [key] = await this.db.query<ApiKey>(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, budget_micros)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${KEY_COLUMNS}`,
      [id, name, hashKey(secret), secret.slice(0, 10), budgetMicros],
    );
    return { key: key!, secret };
  }

  async findBySecret(secret: string): Promise<ApiKey | null> {
    const rows = await this.db.query<ApiKey>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE key_hash = $1`,
      [hashKey(secret)],
    );
    return rows[0] ?? null;
  }

  async getKey(id: string): Promise<ApiKey | null> {
    const rows = await this.db.query<ApiKey>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listKeys(): Promise<ApiKey[]> {
    return this.db.query<ApiKey>(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC`);
  }

  async updateKey(id: string, patch: { budgetMicros?: number; status?: "active" | "revoked" }) {
    const rows = await this.db.query<ApiKey>(
      `UPDATE api_keys SET
         budget_micros = COALESCE($2, budget_micros),
         status = COALESCE($3, status)
       WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
      [id, patch.budgetMicros ?? null, patch.status ?? null],
    );
    return rows[0] ?? null;
  }

  /**
   * Atomically holds `amount` against the key's budget and records a pending event.
   *
   * The conditional UPDATE is the concurrency control: Postgres takes a row lock,
   * so two concurrent reservations on the same key serialize, and the second one
   * re-evaluates the WHERE against the first one's committed reserved_micros.
   * No read-then-write window exists for an over-spend to slip through.
   */
  async reserve(
    keyId: string,
    amount: number,
    event: { id: string; requestedModel: string; routeReason: string },
  ): Promise<void> {
    await this.db.tx(async (q) => {
      const held = await q.query(
        `UPDATE api_keys SET reserved_micros = reserved_micros + $2
         WHERE id = $1 AND status = 'active'
           AND spent_micros + reserved_micros + $2 <= budget_micros
         RETURNING id`,
        [keyId, amount],
      );
      if (held.length === 0) {
        const [k] = await q.query<ApiKey>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1`, [keyId]);
        if (!k || k.status !== "active") throw new KeyRevokedError("key revoked");
        throw new BudgetExceededError(
          Math.max(0, k.budget_micros - k.spent_micros - k.reserved_micros),
          amount,
        );
      }
      await q.query(
        `INSERT INTO usage_events (id, key_id, status, requested_model, route_reason, reserved_micros)
         VALUES ($1, $2, 'pending', $3, $4, $5)`,
        [event.id, keyId, event.requestedModel, event.routeReason, amount],
      );
    });
  }

  /**
   * Converts a reservation into actual spend. Usage row and key balance change in
   * one transaction, so "sum of usage_events.cost" always equals spent_micros.
   * If the sweeper already expired this reservation, it has already been released;
   * we still record the real cost.
   */
  async settle(eventId: string, keyId: string, s: Settlement): Promise<void> {
    await this.db.tx(async (q) => {
      const [prev] = await q.query<{ status: string; reserved_micros: number }>(
        `SELECT status, reserved_micros FROM usage_events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      if (!prev) throw new Error(`settle: unknown event ${eventId}`);
      if (prev.status !== "pending" && prev.status !== "expired") return;

      const release = prev.status === "pending" ? prev.reserved_micros : 0;
      await q.query(
        `UPDATE usage_events SET status = $2, provider = $3, model = $4, attempts = $5,
           input_tokens = $6, output_tokens = $7, cost_micros = $8, latency_ms = $9,
           error = $10, settled_at = now()
         WHERE id = $1`,
        [eventId, s.status, s.provider ?? null, s.model ?? null, s.attempts, s.inputTokens,
         s.outputTokens, s.costMicros, s.latencyMs, s.error?.slice(0, 1000) ?? null],
      );
      await q.query(
        `UPDATE api_keys SET reserved_micros = GREATEST(0, reserved_micros - $2),
           spent_micros = spent_micros + $3
         WHERE id = $1`,
        [keyId, release, s.costMicros],
      );
    });
  }

  /** Releases reservations whose request died without settling (crash, deploy, kill -9). */
  async sweepExpired(ttlMs: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `WITH exp AS (
         UPDATE usage_events SET status = 'expired', settled_at = now(),
           error = 'reservation expired before settlement'
         WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1::float8 / 1000)
         RETURNING key_id, reserved_micros
       ), agg AS (
         SELECT key_id, SUM(reserved_micros)::bigint AS total, COUNT(*)::int AS n FROM exp GROUP BY key_id
       ), upd AS (
         UPDATE api_keys k SET reserved_micros = GREATEST(0, k.reserved_micros - agg.total)
         FROM agg WHERE k.id = agg.key_id RETURNING agg.n
       )
       SELECT COALESCE(SUM(n), 0)::int AS n FROM upd`,
      [ttlMs],
    );
    return rows[0]?.n ?? 0;
  }

  async usage(keyId: string, sinceIso?: string) {
    const since = sinceIso ?? "1970-01-01T00:00:00Z";
    const [totals] = await this.db.query(
      `SELECT COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
         COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
         COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(cost_micros), 0)::bigint AS cost_micros
       FROM usage_events WHERE key_id = $1 AND created_at >= $2`,
      [keyId, since],
    );
    const byModel = await this.db.query(
      `SELECT provider, model, COUNT(*)::int AS requests,
         SUM(input_tokens)::bigint AS input_tokens, SUM(output_tokens)::bigint AS output_tokens,
         SUM(cost_micros)::bigint AS cost_micros
       FROM usage_events WHERE key_id = $1 AND created_at >= $2 AND status = 'ok'
       GROUP BY provider, model ORDER BY cost_micros DESC`,
      [keyId, since],
    );
    const recent = await this.db.query(
      `SELECT id, status, requested_model, route_reason, provider, model, attempts,
         input_tokens, output_tokens, cost_micros, latency_ms, error, created_at
       FROM usage_events WHERE key_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [keyId],
    );
    return { totals, byModel, recent };
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }
}
