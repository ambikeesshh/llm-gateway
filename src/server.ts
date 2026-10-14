import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { buildDeployments } from "./routing.js";

const cfg = loadConfig();
const db = cfg.DATABASE_URL ? await createPgDb(cfg.DATABASE_URL) : await createPgliteDb(cfg.PGLITE_DIR ?? "./.data/pglite");
await migrate(db);

const deployments = buildDeployments(cfg);
const { app, store } = await buildApp({ cfg, db, deployments });

app.log.info(
  { deployments: deployments.map((d) => `${d.name}=${d.provider.name}/${d.model}`), db: cfg.DATABASE_URL ? "postgres" : "pglite" },
  "gateway configured",
);

const sweep = setInterval(async () => {
  try {
    const n = await store.sweepExpired(cfg.RESERVATION_TTL_MS);
    if (n > 0) app.log.warn({ released: n }, "released expired budget reservations");
  } catch (err) {
    app.log.error({ err }, "reservation sweep failed");
  }
}, 60_000);
sweep.unref();

await app.listen({ port: cfg.PORT, host: cfg.HOST });

// Render sends SIGTERM on deploy; let in-flight requests settle their spend before exit.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, "shutting down");
    clearInterval(sweep);
    await app.close();
    await db.close();
    process.exit(0);
  });
}
