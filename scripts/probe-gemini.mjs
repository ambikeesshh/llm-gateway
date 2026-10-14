// Sends one raw request to Gemini's OpenAI-compatible endpoint and prints the usage block.
// Usage: node scripts/probe-gemini.mjs <model> [max_tokens] [reasoning_effort]
import "dotenv/config";

const [model = "gemini-3.8-flash", maxTokens = "200", effort] = process.argv.slice(2);
const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
  body: JSON.stringify({
    model,
    max_tokens: Number(maxTokens),
    ...(effort ? { reasoning_effort: effort } : {}),
    messages: [{ role: "user", content: "In one sentence, what is a budget reservation?" }],
  }),
});
const body = await res.json();
console.log(res.status, JSON.stringify({ choice: body.choices?.[0], usage: body.usage, error: body.error }, null, 1));
