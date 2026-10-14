// Lists Gemini models the configured key can call. Usage: node scripts/list-gemini-models.mjs
import "dotenv/config";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set");

const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
  headers: { "x-goog-api-key": key },
});
const body = await res.json();
if (!res.ok) {
  console.error(res.status, body.error?.message);
  process.exit(1);
}
for (const m of body.models) {
  if (m.supportedGenerationMethods?.includes("generateContent")) {
    console.log(m.name.replace("models/", ""), "|", m.displayName);
  }
}
