// Verifies DATABASE_URL connectivity + TLS and ensures a separate `gateway_test` database
// exists for the test suite. Prints the test URL with --print-test-url (for piping only).
import "dotenv/config";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const url = process.env.DATABASE_URL.replace("sslmode=require", "sslmode=verify-full");
const testUrl = Object.assign(new URL(url), { pathname: "/gateway_test" }).toString();

if (process.argv.includes("--print-test-url")) {
  process.stdout.write(testUrl);
  process.exit(0);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const [{ version }] = (await client.query("SELECT version()")).rows;
const [ssl] = (await client.query("SELECT ssl, version AS tls FROM pg_stat_ssl WHERE pid = pg_backend_pid()")).rows;
console.log("server:", version.split(" on ")[0]);
console.log("tls:", ssl ?? "(pg_stat_ssl not visible through pooler)");
console.log("cert verified by client:", client.connection.stream.authorized ?? "n/a");

const exists = (await client.query("SELECT 1 FROM pg_database WHERE datname = 'gateway_test'")).rowCount;
if (!exists) {
  await client.query("CREATE DATABASE gateway_test");
  console.log("created database gateway_test");
} else {
  console.log("database gateway_test already exists");
}
await client.end();
