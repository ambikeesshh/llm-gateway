import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// BIGINT (int8) comes back as a string by default; our values are micro-rupees,
// far below Number.MAX_SAFE_INTEGER, so parse them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

// pg 8 treats require/prefer/verify-ca as verify-full, but pg 9 switches to libpq
// semantics where `require` skips certificate checks. Pin verify-full explicitly.
export function withVerifiedTls(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer" || mode === "verify-ca") u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

export async function createPgDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: withVerifiedTls(url), max: 10 });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (sql, params) => (await client.query(sql, params)).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const lite = new PGlite(dataDir);
  const toNum = (rows: Record<string, unknown>[]) =>
    rows.map((r) => {
      for (const k in r) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
      return r;
    });
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return toNum((await lite.query(sql, params)).rows as Record<string, unknown>[]) as T[];
    },
    async tx(fn) {
      return lite.transaction(async (t) =>
        fn({
          query: async <T>(sql: string, params?: unknown[]) =>
            toNum((await t.query(sql, params)).rows as Record<string, unknown>[]) as T[],
        }),
      );
    },
    close: () => lite.close(),
  };
}

export async function migrate(db: Db): Promise<void> {
  const path = fileURLToPath(new URL("../schema.sql", import.meta.url));
  const sql = await readFile(path, "utf8");
  for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}
