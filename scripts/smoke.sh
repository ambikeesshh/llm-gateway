#!/usr/bin/env bash
# End-to-end check against a running gateway.
# Usage: ADMIN_TOKEN=... scripts/smoke.sh [base_url]   (defaults to http://localhost:8080)
set -euo pipefail
B="${1:-http://localhost:8080}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"
json() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

echo "== health"
curl -sS -m 90 "$B/healthz" || { echo; echo "cannot reach $B (is the server running?)"; exit 1; }
echo

echo "== create key (₹1 budget)"
K=$(curl -sS -X POST "$B/admin/keys" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"smoke","budget_inr":1}')
case "$K" in *api_key*) ;; *) echo "key creation failed: $K"; echo "(check ADMIN_TOKEN matches this server)"; exit 1;; esac
KEY=$(echo "$K" | json api_key); ID=$(echo "$K" | json id); echo "$ID"

call() {
  curl -s -o /tmp/smoke.json -D /tmp/smoke.h -w '%{http_code}' "$B/v1/chat/completions" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "$1"
}

echo "== auto-routed request"
code=$(call '{"model":"auto","max_tokens":300,"messages":[{"role":"user","content":"Name three prime numbers."}]}')
echo "HTTP $code"; grep -i '^x-gateway' /tmp/smoke.h || true; cat /tmp/smoke.json; echo

echo "== classification hint"
code=$(call '{"model":"auto","max_tokens":60,"metadata":{"task":"classification"},"messages":[{"role":"system","content":"Classify sentiment as positive or negative. Reply with one word."},{"role":"user","content":"I love this product"}]}')
echo "HTTP $code"; grep -i '^x-gateway' /tmp/smoke.h || true; cat /tmp/smoke.json; echo

echo "== worst case exceeds remaining budget -> 402 before any provider call"
code=$(call '{"model":"capable","max_tokens":4000,"messages":[{"role":"user","content":"Say ok."}]}')
echo "HTTP $code"; cat /tmp/smoke.json; echo

echo "== cut budget to ₹0.01 -> every request blocked"
curl -sS -X PATCH "$B/admin/keys/$ID" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"budget_inr":0.01}' >/dev/null
code=$(call '{"model":"cheap","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
echo "HTTP $code"; cat /tmp/smoke.json; echo

echo "== usage for $ID"
curl -sS "$B/admin/usage?key_id=$ID" -H "authorization: Bearer $ADMIN_TOKEN" | node -pe \
  'const u=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({key:u.key, totals:u.totals, by_model:u.by_model}, null, 1)'
