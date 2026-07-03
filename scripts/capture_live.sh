#!/usr/bin/env bash
# Drive the LIVE Archon MemoryAgent on Alibaba Cloud and capture a REAL run into
# docs/screencast_transcript.txt (consumed by scripts/make_screencast.py).
#
# It LEADS with the innovation headline — self-auditing memory (detect -> resolve) —
# then proves the MemoryAgent track's core claim (cross-session persistence):
#   PROOF 1     GET  /health          -> real Qwen on Alibaba (text-embedding-v4 + qwen-plus)
#   INNOVATION  POST /ingest x2       -> two SEPARATE write events remember ONE record
#               POST /consistency       differently; the agent DETECTS the contradiction
#                                       and RECOMMENDS which value to trust (resolution)
#   SESSION A   POST /ingest          -> writes fused financial memories to pgvector on Alibaba
#   SESSION B   POST /recall (x2)     -> a FRESH session recalls them by MEANING; real
#                                       qwen-plus answers + real pgvector cosine scores
#
# HARD-CHECKED end to end (structured jq gates, not string-matching), so a box that
# is down, or that silently reverted to the offline Fakes (no DASHSCOPE key), or a
# blank/stub recall, or a self-audit that fails to flag the seeded contradiction,
# FAILS the job instead of shipping a fake-looking video.
#
# Each run uses UNIQUE companies ("DemoRun <run-id>" + "... audit") so the audit and
# the cross-session recall are isolated from each other and immune to accumulated
# rows on the live box — "A wrote it, B recalled it" and "the agent caught its own
# contradiction" are both deterministic.
#
# NOTE: this drives the field-renamed API (employer_social_security_total, etc.).
# Run it against a box redeployed from this branch (deploy/redeploy.sh --truncate).
#
# Env:
#   DEMO_BASE_URL  live base URL (default http://43.106.13.19:9000)
#   GITHUB_RUN_ID  used to make the companies/events unique (falls back to a timestamp)
#   TRANSCRIPT     output transcript path (default docs/screencast_transcript.txt)
set -euo pipefail

BASE="${DEMO_BASE_URL:-http://43.106.13.19:9000}"
RUN="${GITHUB_RUN_ID:-local$(date +%s)}"
COMPANY="DemoRun ${RUN}"
AUDIT_COMPANY="DemoRun ${RUN} audit"
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

# ============================================================ INNOVATION
# Self-auditing memory: two SEPARATE write events remember the SAME record with a
# DIFFERENT employer-cost figure (a later reconciliation "corrected" it). A plain
# recall would silently return one of them; /consistency DETECTS the disagreement
# and RECOMMENDS which side to trust (importance -> source-authority -> recency).
# Universal financial terms only, no country-specific authority.
audit_event() { # $1 = employer_cost_total
cat <<JSON
{"event":{"event_id":"evt-audit-${RUN}","company":"${AUDIT_COMPANY}","period":"2026-05","employee_count":2,"bank_net_total":10000,"gross_total":13000,"employer_social_security_total":2800,"employee_social_security_total":1000,"tax_withheld_total":1200,"employer_cost_total":$1,"cost_gap_amount":2800,"cost_gap_pct":28.0,"hidden_total":5800,"employees":[{"employee_id":"E-01","name":"Elena Novak","gross":8000,"employee_social_security":600,"tax":800,"net":6600,"employer_social_security":1800,"employer_cost":9800},{"employee_id":"E-02","name":"David Chen","gross":5000,"employee_social_security":400,"tax":400,"net":4200,"employer_social_security":1000,"employer_cost":6000}],"linked_docs":["doc-bank-1","doc-reg-1"]}}
JSON
}

# Write event #1 — employer cost recorded as €18,000.
curl -fsS -m 60 -X POST "$BASE/ingest" -H 'Content-Type: application/json' -d "$(audit_event 18000)" >/dev/null \
  || fail "/ingest (audit write #1) failed"
# Write event #2 — a LATER session records €19,000 for the SAME event.
curl -fsS -m 60 -X POST "$BASE/ingest" -H 'Content-Type: application/json' -d "$(audit_event 19000)" >/dev/null \
  || fail "/ingest (audit write #2) failed"

CONS=$(curl -fsS -m 60 -X POST "$BASE/consistency" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "$AUDIT_COMPANY" '{company:$c}')") \
  || fail "/consistency (self-audit) failed"
echo "consistency: $CONS"
echo "$CONS" | jq -e '
  .ok==false
  and (.contradictions|length)==1
  and .contradictions[0].attribute=="employer_cost_total"
  and (.contradictions[0].values|map(.value)|sort)==[18000,19000]
  and .contradictions[0].resolution.rule=="recency"
  and .contradictions[0].resolution.recommendedValue==19000' >/dev/null \
  || fail "/consistency did not detect+resolve the seeded contradiction (got: $(echo "$CONS" | jq -c '{ok, contradictions:(.contradictions|length), first:.contradictions[0]}'))"
CONS_SUBJECT=$(echo "$CONS" | jq -r '.contradictions[0].subject')
CONS_VALS=$(echo "$CONS" | jq -r '.contradictions[0].values|map(.value)|join(" vs ")')
CONS_RULE=$(echo "$CONS" | jq -r '.contradictions[0].resolution.rule')
CONS_REC=$(echo "$CONS" | jq -r '.contradictions[0].resolution.recommendedValue')
CONS_CONF=$(echo "$CONS" | jq -r '.contradictions[0].resolution.confidence')
CONS_WHY=$(echo "$CONS" | jq -r '.contradictions[0].resolution.rationale')

# ------------------------------------------------- SESSION A · ingest (cross-session)
# Workforce-cost example: bank net €10,000 vs TRUE employer cost €15,800 (the €5,800
# wedge the bank statement alone never shows). Universal terms only, no local authority.
EVENT=$(cat <<JSON
{"event":{"event_id":"evt-${RUN}","company":"${COMPANY}","period":"2026-05","employee_count":2,"bank_net_total":10000,"gross_total":13000,"employer_social_security_total":2800,"employee_social_security_total":1000,"tax_withheld_total":1200,"employer_cost_total":15800,"cost_gap_amount":2800,"cost_gap_pct":28.0,"hidden_total":5800,"employees":[{"employee_id":"E-01","name":"Elena Novak","gross":8000,"employee_social_security":600,"tax":800,"net":6600,"employer_social_security":1800,"employer_cost":9800},{"employee_id":"E-02","name":"David Chen","gross":5000,"employee_social_security":400,"tax":400,"net":4200,"employer_social_security":1000,"employer_cost":6000}],"linked_docs":["doc-bank-1","doc-reg-1"]}}
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
#
# hybrid:false  →  PURE DENSE (cosine ANN) recall, on purpose. The demo VISUALISES
# and HARD-CHECKS a real cosine similarity (the transcript labels the numbers
# "cosine similarity over pgvector" and the narration says "cosine ANN over
# pgvector"), and dense recall is the path whose `hit.score` IS that cosine
# similarity (score = 1 - cosine_distance; ~0.44 for the aligned demo query). The
# product-default recall path is HYBRID — dense + lexical fused with Reciprocal
# Rank Fusion — and RRF scores are RANK-based (top hit = 1/(60+1) ≈ 0.016), NOT
# cosine. Surfacing an RRF score as "cosine" is exactly what made a perfectly
# grounded recall (correct memory ranked #1, cited, accurate answer) read as
# broken at 0.016. Hybrid stays the SOTA product default (see BENCHMARK.md); the
# DEMO just reports the honest, human-meaningful metric its own narration promises.
Q1="What was the true cost of employing our team last month compared with what actually left the bank account?"
R1=$(curl -fsS -m 90 -X POST "$BASE/recall" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q1" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3, hybrid:false}')") \
  || fail "/recall (Session B, Q1) failed"
echo "recall1: $R1"
echo "$R1" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0 and (.hits[0].score>0.35)' >/dev/null \
  || fail "/recall Q1 is not a real grounded qwen-plus answer over real memory (got: $(echo "$R1" | jq -c '{modelId, hits:(.hits|length), top:(.hits[0].score)}'))"
A1=$(echo "$R1" | jq -r '.answer' | tr '\n' ' ' | tr -s ' ')
[ -n "$A1" ] || fail "/recall Q1 returned an empty answer"
SCORES1=$(echo "$R1" | jq -r '.citations[] | "  \(.marker) kind=\(.kind)  cosine=\(((.score*1000)|round)/1000)  ref=\(.sourceRef)"')

Q2="What was the total cost of employing Elena last month?"
R2=$(curl -fsS -m 90 -X POST "$BASE/recall" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q2" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3, hybrid:false}')") \
  || fail "/recall (Session B, Q2) failed"
echo "recall2: $R2"
echo "$R2" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0 and (.hits[0].score>0.35)' >/dev/null \
  || fail "/recall Q2 is not a real grounded qwen-plus answer over real memory (got: $(echo "$R2" | jq -c '{modelId, hits:(.hits|length), top:(.hits[0].score)}'))"
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

t "0.0 \$ # Archon MemoryAgent  ·  self-auditing, cross-session memory on Alibaba Cloud"
t "2.5 \$ # The ONLY shared state across sessions is pgvector on Alibaba."
t "5.5 \$ # ---- PROOF 1 · real Qwen, live on Alibaba Cloud ----"
t "7.0 \$ curl -s $BASE/health"
t "9.0   $HEALTH_C"
t "10.0 → embedder=text-embedding-v4 · narrator=qwen-plus · 1024-dim  (REAL Qwen, not a stub)"
t "13.5 \$ # ---- ⭐ INNOVATION · memory that AUDITS ITSELF (detect → resolve) ----"
t "16.5 \$ # Two SEPARATE write events remember ONE record with a different employer cost."
t "20.0 \$ curl -X POST $BASE/ingest -d @event.json   # write #1: employer cost €18,000"
t "23.0 \$ curl -X POST $BASE/ingest -d @event.json   # write #2 (a LATER session): €19,000"
t "26.5 \$ # A plain recall would silently return one of them. Instead, ask the agent"
t "29.0 \$ # to audit its OWN memory:"
t "31.5 \$ curl -X POST $BASE/consistency -d '{\"company\":\"$AUDIT_COMPANY\"}'"
t "34.5 → CONTRADICTION on '$CONS_SUBJECT' · attribute employer_cost_total · $CONS_VALS"
t "38.5 → RESOLUTION (recommender, never mutates memory): trust $CONS_REC  [rule=$CONS_RULE · confidence=$CONS_CONF]"
t "42.5   $CONS_WHY"
t "46.5 >> The memory DETECTED its own cross-session disagreement and RECOMMENDED which to trust."
t "50.5 \$ # ---- SESSION A · write memory (cross-session persistence) ----"
t "53.0 \$ # An agent fused bank + payroll-register + payslips into ONE financial event."
t "55.5 \$ # It commits the salient facts so a LATER, separate session can recall them."
t "58.0 \$ curl -X POST $BASE/ingest -d @event.json"
t "59.5   # event: company=\"$COMPANY\"  bank net €10,000 · TRUE employer cost €15,800 · hidden €5,800"
t "61.5   $INGEST_C"
t "62.5 → $WRITTEN memories embedded with text-embedding-v4 → written to pgvector on Alibaba"
t "66.0 \$ # SESSION A IS OVER. The client disconnects; nothing stays in process memory."
t "68.5 \$ # The facts now live ONLY in pgvector on Alibaba Cloud."
t "71.5 \$ # ---- SESSION B · a fresh, later session ----"
t "74.0 \$ # A DIFFERENT client. No shared variables, no cache — only a question."
t "77.0 \$ curl -X POST $BASE/recall \\\\"
t "78.0   -d '{\"question\":\"$Q1\", \"company\":\"$COMPANY\", \"kind\":\"payroll_event\"}'"
t "80.5 \$ # Qwen embeds the question → cosine ANN over pgvector → qwen-plus grounds the answer"
t "84.0 ANSWER (qwen-plus · grounded in memory written during Session A):"
t "85.0   $A1"
t "98.0 Recalled by MEANING — real cosine similarity over pgvector (higher = closer):"
blk "$SCORES1"
t "104.5 >> A memory WRITTEN in Session A was RETRIEVED in Session B — cross-session persistence."
t "108.5 \$ # ---- SESSION B · a second, different question ----"
t "110.5 \$ # Memory is genuinely QUERYABLE, not a canned reply. Ask something else:"
t "113.5 \$ curl -X POST $BASE/recall -d '{\"question\":\"$Q2\", \"company\":\"…\", \"kind\":\"payroll_event\"}'"
t "116.5 ANSWER (qwen-plus):"
t "117.5   $A2"
t "130.5 Recalled memory items (cosine over pgvector):"
blk "$SCORES2"
t "137.0 >> Same persistent memory · a new query · a new grounded answer."
t "140.5 \$ # ---- PROOF 3 · running on Alibaba Cloud ----"
t "142.5   Live URL :  $BASE      (public · reachable now)"
t "144.0   Compute  :  Alibaba Cloud ECS · ecs.e-c1m2.large · ap-southeast-1 (Singapore)"
t "145.5   Memory   :  pgvector container on the ECS box · HNSW cosine · vector(1024)"
t "147.0   Models   :  Qwen text-embedding-v4  +  qwen-plus  (Model Studio / DashScope)"
t "150.0 >> Self-auditing. Persistent. Queryable. Across sessions. — proven live."

echo "== transcript written to $OUT =="
cat "$OUT"
