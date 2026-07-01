#!/usr/bin/env bash
# Drive the LIVE Archon MemoryAgent on Alibaba Cloud and capture a REAL two-session
# run into docs/screencast_transcript.txt (consumed by scripts/make_screencast.py).
#
# It proves the MemoryAgent track's headline claim against the live box:
#   PROOF 1  GET  /health         -> real Qwen on Alibaba (text-embedding-v4 + qwen-plus)
#   SESSION A POST /ingest        -> writes fused payroll memories to pgvector on Alibaba
#   SESSION B POST /recall (x2)   -> a FRESH session recalls them by MEANING; real
#                                    qwen-plus answers + real pgvector cosine scores
#
# HARD-CHECKED end to end (structured jq gates, not string-matching), so a box that
# is down, or that silently reverted to the offline Fakes (no DASHSCOPE key), or a
# blank/stub recall, FAILS the job instead of shipping a fake-looking video.
#
# Each run uses a UNIQUE company ("DemoRun <run-id>") so Session B's company-filtered
# recall returns ONLY this run's memories — the "A wrote it, B recalled it" proof is
# deterministic and immune to accumulated rows on the live box.
#
# Env:
#   DEMO_BASE_URL  live base URL (default http://43.106.13.19:9000)
#   GITHUB_RUN_ID  used to make the company/event unique (falls back to a timestamp)
#   TRANSCRIPT     output transcript path (default docs/screencast_transcript.txt)
set -euo pipefail

BASE="${DEMO_BASE_URL:-http://43.106.13.19:9000}"
RUN="${GITHUB_RUN_ID:-local$(date +%s)}"
COMPANY="DemoRun ${RUN}"
OUT="${TRANSCRIPT:-docs/screencast_transcript.txt}"
mkdir -p "$(dirname "$OUT")"

command -v jq >/dev/null 2>&1 || { echo "::error::jq is required"; exit 1; }
fail() { echo "::error::$*" >&2; exit 1; }

echo "== driving live box: $BASE (company='$COMPANY') =="

# ------------------------------------------------------------------ PROOF 1
HEALTH=$(curl -fsS -m 25 "$BASE/health") \
  || fail "live Alibaba box unreachable at $BASE/health — the ECS instance may be stopped"
echo "health: $HEALTH"
echo "$HEALTH" | jq -e '.embedder=="text-embedding-v4" and .narrator=="qwen-plus" and .embedDim==1024' >/dev/null \
  || fail "/health is not real Qwen (got: $HEALTH) — the box may have restarted WITHOUT DASHSCOPE_API_KEY (reverts to fake-hash-embedder)"
HEALTH_C=$(echo "$HEALTH" | jq -c .)

COUNT=$(curl -fsS -m 25 "$BASE/memory/count") || fail "/memory/count unreachable"
COUNT_C=$(echo "$COUNT" | jq -c .)
echo "count: $COUNT_C"

# ------------------------------------------------------- SESSION A · ingest
# Workforce-cost example: bank net €10,000 vs TRUE employer cost €15,800 (the €5,800
# wedge the bank statement alone never shows). Universal terms only, no local authority.
EVENT=$(cat <<JSON
{"event":{"event_id":"evt-${RUN}","company":"${COMPANY}","period":"2026-05","employee_count":2,"bank_net_total":10000,"gross_total":13000,"employer_ika_total":2800,"employee_ika_total":1000,"tax_withheld_total":1200,"employer_cost_total":15800,"cost_gap_amount":2800,"cost_gap_pct":28.0,"hidden_total":5800,"employees":[{"employee_id":"E-01","name":"Maria Papadopoulou","gross":8000,"employee_ika":600,"tax":800,"net":6600,"employer_ika":1800,"employer_cost":9800},{"employee_id":"E-02","name":"Nikos Georgiou","gross":5000,"employee_ika":400,"tax":400,"net":4200,"employer_ika":1000,"employer_cost":6000}],"linked_docs":["doc-bank-1","doc-reg-1"]}}
JSON
)
INGEST=$(curl -fsS -m 60 -X POST "$BASE/ingest" -H 'Content-Type: application/json' -d "$EVENT") \
  || fail "/ingest (Session A) failed"
echo "ingest: $INGEST"
echo "$INGEST" | jq -e '.written>=1' >/dev/null || fail "/ingest wrote no memories (got: $INGEST)"
WRITTEN=$(echo "$INGEST" | jq -r '.written')
INGEST_C=$(echo "$INGEST" | jq -c '{written, ids: (.ids[0:2] + ["..."])}')

# ------------------------------------------------- SESSION B · recall (x2)
# Recall is filtered to kind="payroll_event" (event summary + per-employee lines):
# universal financial facts, no country-specific authority names in the grounding.
Q1="What was the true cost of employing our team last month compared with what actually left the bank account?"
R1=$(curl -fsS -m 90 -X POST "$BASE/recall" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q1" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3}')") \
  || fail "/recall (Session B, Q1) failed"
echo "recall1: $R1"
echo "$R1" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0 and (.hits[0].score>0.35)' >/dev/null \
  || fail "/recall Q1 is not a real grounded qwen-plus answer over real memory (got: $(echo "$R1" | jq -c '{modelId, hits:(.hits|length), top:(.hits[0].score)}'))"
A1=$(echo "$R1" | jq -r '.answer' | tr '\n' ' ' | tr -s ' ')
[ -n "$A1" ] || fail "/recall Q1 returned an empty answer"
SCORES1=$(echo "$R1" | jq -r '.citations[] | "  \(.marker) kind=\(.kind)  cosine=\(((.score*1000)|round)/1000)  ref=\(.sourceRef)"')

Q2="What was the total cost of employing Maria last month?"
R2=$(curl -fsS -m 90 -X POST "$BASE/recall" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q2" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3}')") \
  || fail "/recall (Session B, Q2) failed"
echo "recall2: $R2"
echo "$R2" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0' >/dev/null || fail "/recall Q2 invalid"
A2=$(echo "$R2" | jq -r '.answer' | tr '\n' ' ' | tr -s ' ')
[ -n "$A2" ] || fail "/recall Q2 returned an empty answer"
SCORES2=$(echo "$R2" | jq -r '.citations[] | "  \(.marker) kind=\(.kind)  cosine=\(((.score*1000)|round)/1000)"')

# ---------------------------------------------------- build the transcript
# Time prefix = screencast-local seconds (matches scripts/captions.txt + the VO).
# Lines are the REAL captured values. Answers are ONE logical line each (newlines
# stripped) so they appear atomically at their anchor and cannot overflow/reorder.
: > "$OUT"
t() { printf '%s\n' "$1" >> "$OUT"; }        # timed line ("<sec> text")
blk() { printf '%s\n' "$1" >> "$OUT"; }      # untimed block (inherits prev+0.4s)

t "0.0 \$ # Archon MemoryAgent  ·  cross-session memory on Alibaba Cloud"
t "2.5 \$ # Two SEPARATE client sessions. The ONLY shared state is pgvector on Alibaba."
t "5.5 \$ # ---- PROOF 1 · real Qwen, live on Alibaba Cloud ----"
t "7.0 \$ curl -s $BASE/health"
t "9.0   $HEALTH_C"
t "10.0 → embedder=text-embedding-v4 · narrator=qwen-plus · 1024-dim  (REAL Qwen, not a stub)"
t "13.5 \$ curl -s $BASE/memory/count"
t "15.0   $COUNT_C"
t "18.0 \$ # ---- SESSION A · write memory ----"
t "20.5 \$ # An agent fused bank + payroll-register + payslips into ONE PayrollEvent."
t "23.0 \$ # It commits the salient facts so a LATER, separate session can recall them."
t "26.0 \$ curl -X POST $BASE/ingest -d @event.json"
t "27.5   # event: company=\"$COMPANY\"  bank net €10,000 · TRUE employer cost €15,800 · hidden €5,800"
t "30.0   $INGEST_C"
t "31.0 → $WRITTEN memories embedded with text-embedding-v4 → written to pgvector on Alibaba"
t "35.0 \$ # SESSION A IS OVER. The client disconnects; nothing stays in process memory."
t "38.0 \$ # The facts now live ONLY in pgvector on Alibaba Cloud."
t "42.0 \$ # ---- SESSION B · a fresh, later session ----"
t "44.5 \$ # A DIFFERENT client. No shared variables, no cache — only a question."
t "48.0 \$ curl -X POST $BASE/recall \\\\"
t "49.0   -d '{\"question\":\"$Q1\", \"company\":\"$COMPANY\", \"kind\":\"payroll_event\"}'"
t "52.0 \$ # Qwen embeds the question → cosine ANN over pgvector → qwen-plus grounds the answer"
t "56.0 ANSWER (qwen-plus · grounded in memory written during Session A):"
t "57.0   $A1"
t "74.0 Recalled by MEANING — real cosine similarity over pgvector (higher = closer):"
blk "$SCORES1"
t "82.0 >> A memory WRITTEN in Session A was RETRIEVED in Session B — cross-session persistence."
t "87.0 \$ # ---- SESSION B · a second, different question ----"
t "89.5 \$ # Memory is genuinely QUERYABLE, not a canned reply. Ask something else:"
t "93.0 \$ curl -X POST $BASE/recall -d '{\"question\":\"$Q2\", \"company\":\"…\", \"kind\":\"payroll_event\"}'"
t "96.0 ANSWER (qwen-plus):"
t "97.0   $A2"
t "114.0 Recalled memory items (cosine over pgvector):"
blk "$SCORES2"
t "121.0 >> Same persistent memory · a new query · a new grounded answer."
t "125.0 \$ # ---- PROOF 3 · running on Alibaba Cloud ----"
t "127.0   Live URL :  $BASE      (public · reachable now)"
t "128.5   Compute  :  Alibaba Cloud ECS · ecs.e-c1m2.large · ap-southeast-1 (Singapore)"
t "130.0   Memory   :  pgvector on Alibaba Cloud PostgreSQL · HNSW cosine · vector(1024)"
t "131.5   Models   :  Qwen text-embedding-v4  +  qwen-plus  (Model Studio / DashScope)"
t "135.0 >> Persistent. Queryable. Across sessions. — the MemoryAgent track, proven live."

echo "== transcript written to $OUT =="
cat "$OUT"
