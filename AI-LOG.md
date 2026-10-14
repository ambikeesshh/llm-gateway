# AI-LOG

## Tools

Cursor in agent mode, running Claude. To be straight about it: the AI wrote most of the code, the tests and the first drafts of the docs. I directed it, reviewed what it produced, tested it against the real APIs and the real deployment, and did everything that needed my own accounts.

## My part

- **Stack and scope.** I picked TypeScript, Postgres (Neon) and Render. The stretch goal is one combined feature: a cost router whose cheap path can be a local model.
- **Always use current docs.** I made it check Google's live docs for models and prices instead of trusting its memory. That one rule surfaced the biggest bug in the project: thinking tokens being under-billed about 25×. Details below.
- **Reviewing the design.** The AI proposed the core design: reserve the worst case and settle later, money in micro-rupees, one attempt per model, a circuit breaker. I went through each part, and kept it once I could explain why it beats the alternatives (see `DECISIONS.md`). The same-tier fallback (3.8 Flash → 3.6 Flash) came out of the outage I watched on deploy day.
- **Infra.** I set up the Gemini key, Neon, Render and GitHub. I caught that Render was linked to the wrong GitHub account, and fixed the deploy credentials before shipping.
- **Testing it myself.** I ran the smoke test against production and found it failing silently (the `cut` bug below). I noticed the dashboard stuck on "unreachable" while the API was fine. I pulled the real free-tier limits from AI Studio and wrote down what they mean for the design.
- **Control.** Every commit and push went through my review and approval.

## Where the AI got it wrong

**Old models, and billing tokens wrong.** The first version used `gemini-2.5-flash` and its prices, straight out of training data. I told it to go by Google's current docs. The pricing page had moved on to 3.x, and listing the models my key could actually call confirmed `gemini-3.8-flash` and `gemini-3.5-flash-lite`.

Checking the real API turned up the bigger problem. A raw call returned `completion_tokens: 8` but `total_tokens: 207`. Gemini 3 bills its thinking tokens as output, but they don't show up in `completion_tokens`. The gateway was billing `completion_tokens`, so that call would have been under-charged about 25×. Every test still passed, because the tests used a mock built on the same wrong assumption. Only the real API showed it. Now it bills `total − prompt`, and there's a regression test built from that exact response.

**A concurrency test that couldn't fail.** The first version fired 25 parallel requests at a small budget, but each request was so cheap that all 25 fit even run one at a time. It would have passed with the locking deleted. The AI caught this one itself while checking the numbers, and changed the prompt size so real spend runs out after about 4 requests. Then I ran the suite on real Postgres on Neon too, because the local embedded database runs one query at a time and can't show locking at all.

**TLS checking turned off.** The first database code connected with `rejectUnauthorized: false`, so it never checked the server's certificate. It's pinned to `sslmode=verify-full` now, and `scripts/db-check.mjs` confirms the certificate actually gets verified.

**A command that broke on my token.** When I ran the smoke test against production myself, it died silently right after the health check. The command the AI gave me used `cut -d= -f2` to pull the admin token out of `.env`. Render's token is base64 and ends in `=`, so `cut` chopped that off and the server rejected the token. The fix was `-f2-`. I also had the script print the server's error instead of exiting quietly.

## Where I overrode it

**I didn't trust its model knowledge.** The AI was confident about `gemini-2.5-flash` and its prices. I overrode that and made it work only from Google's current pricing page, plus the list of models my key can actually call. The models were a generation out of date, and the follow-up probe of the real API is what exposed the thinking-token billing bug. If I'd accepted its first answer, the gateway would have shipped with every Gemini 3 call under-billed.

**Other times I steered it:**
- I noticed the dashboard showing "unreachable" while the API was fine. It turned out the page checked health once on load and never again, so a single blip during a redeploy stuck on screen. It now retries with backoff and re-checks every 30 seconds.
- On Render, I noticed the deploy credentials pointed at the wrong GitHub account. I removed them and connected my own before deploying.

## How I stayed in control of code I didn't type

- **Secrets.** The Gemini key, the Neon connection string and the production admin token live only in a git-ignored `.env` and in Render's dashboard. Before every push, the staged files get scanned for each secret's exact value, and connection strings are checked by shape only, so a value never gets printed.
- **Budget logic.** The core is one conditional `UPDATE`: reserve the money only if `spent + reserved + cost <= budget`. Postgres locks the row, so a second request on the same key waits and then re-checks against the updated row. That's why two requests can't both grab the last of the budget. The tests check that `spent` never goes over budget and that the usage rows always add up to `spent`.
- **The provider call.** I tested fallback against the real API, not just the mock. A misconfigured model got a 404 and fell back. On deploy day, 3.8 Flash was actually returning 503s and hanging; production timed out, fell back, and still answered. That outage is why the same-tier fallback to 3.6 Flash exists.
- **Production.** After every deploy I ran the smoke test against the live URL and checked for a real Gemini answer, a 402 when over budget, and usage totals that match the key's balance. I also pulled the real free-tier limits from AI Studio (20 requests a day on each Flash model, 500 on Flash-Lite) and wrote down what they mean for the design.

## What I learned from scratch

- **Gemini 3 thinking tokens.** They're billed, they're missing from `completion_tokens`, and they come out of `max_tokens`. At a 200-token cap, 3.6 Flash spent about 190 thinking and returned cut-off answers, which is why the default is 1024. I learned it by probing the API with a small script (`scripts/probe-gemini.mjs`) and comparing the numbers.
- **Free-tier deploy constraints.** Two details I had to dig into while deploying. First, Render's free tier has a fixed 30-second shutdown window that can't be extended, so I set the request deadline to 28 seconds; in-flight requests then always settle their spend before a redeploy kills the process. Second, the `pg` driver's next major version changes `sslmode=require` to libpq semantics, which skip certificate checks, so I pinned `verify-full` explicitly.
