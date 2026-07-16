#!/usr/bin/env bash
# Drive the LIVE Archon MemoryAgent on Alibaba Cloud and capture a REAL run into
# docs/screencast_transcript.txt (consumed by scripts/make_screencast.py).
#
# Arc (matches docs/narration.txt + scripts/captions.txt, one shared timeline):
#   PROOF        GET  /health          -> real Qwen on Alibaba (text-embedding-v4 + qwen-plus)
#                GET  /memory/count    -> the live count the Explorer UI shows as a badge
#   LIVE DEMO    POST /ingest          -> SESSION A writes fused financial memories to pgvector
#   (Explorer)   POST /recall (x2)     -> a FRESH SESSION B recalls them by MEANING; real
#                                         qwen-plus answers + real pgvector cosine scores.
#                                         This is exactly what the Explorer UI at BASE/ does:
#                                         company + question -> grounded answer + citations.
#   DIFFERENTIATOR
#                POST /ingest x2       -> two SEPARATE write events remember ONE record with a
#                POST /consistency        DIFFERENT value; the agent DETECTS the contradiction
#                                         and RECOMMENDS which value to trust (the audit is read-only).
#   SEMANTIC     POST /demo/seed       -> seeds two memories that OPPOSE in MEANING with no
#                POST /consistency/semantic  shared field ("on time" vs "chronically late"); the
#                                         configured live Qwen judge flags the contradiction
#                                         the rule-based audit is blind to. Also an MCP tool arg.
#
# HARD-CHECKED end to end (structured jq gates, not string-matching), so a box that
# is down, or that silently reverted to the offline Fakes (no DASHSCOPE key), or a
# blank/stub recall, or a self-audit that fails to flag the seeded contradiction,
# FAILS the job instead of shipping a fake-looking video. A POSITIONING guard also
# fails the run if any recall surfaces a forbidden term (universal financial terms
# only — no country/authority-specific language), so the on-screen answer is clean.
#
# Each run uses UNIQUE companies ("DemoRun <run-id>" + "... audit") so the audit and
# the cross-session recall are isolated from each other and immune to accumulated
# rows on the live box — "A wrote it, B recalled it" and "the agent caught its own
# contradiction" are both deterministic.
#
# Env:
#   DEMO_BASE_URL  live base URL (default https://memory.43.106.13.19.sslip.io)
#   DEMO_JUDGE_API_KEY  dedicated reviewer credential (required; never printed)
#   GITHUB_RUN_ID  used to make the companies/events unique (falls back to a timestamp)
#   TRANSCRIPT     repo-contained output path (default docs/screencast_transcript.txt)
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || fail "python3 is required for repo-contained capture paths"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

BASE="${DEMO_BASE_URL:-https://memory.43.106.13.19.sslip.io}"
RUN="${GITHUB_RUN_ID:-local$(date +%s)}"
COMPANY="DemoRun ${RUN}"
AUDIT_COMPANY="DemoRun ${RUN} audit"
OUT_RAW="${TRANSCRIPT:-docs/screencast_transcript.txt}"
OUT="$(python3 "$SCRIPT_DIR/repo_paths.py" "$OUT_RAW" --label TRANSCRIPT)" \
  || fail "TRANSCRIPT must resolve inside the MemoryAgent repository"
mkdir -p "$(dirname "$OUT")"

command -v jq >/dev/null 2>&1 || { echo "::error::jq is required"; exit 1; }
DEMO_JUDGE_API_KEY="${DEMO_JUDGE_API_KEY:-}"
[ "${#DEMO_JUDGE_API_KEY}" -ge 32 ] \
  || fail "DEMO_JUDGE_API_KEY must be provided as a 32+ character private Actions secret"
AUTH=(-H "Authorization: Bearer ${DEMO_JUDGE_API_KEY}")

# Positioning guard: the memory is a PURE, domain-neutral financial engine. No
# country/authority-specific terms may appear in a recalled, on-screen answer.
FORBIDDEN='hidden|ika|efka|mydata|greek|greece|αφμ'

echo "== driving live box: $BASE (company='$COMPANY') =="

# ------------------------------------------------------------------ PROOF
HEALTH=$(curl -fsS -m 25 "$BASE/health") \
  || fail "live Alibaba box unreachable at $BASE/health — the ECS instance may be stopped"
echo "health: $HEALTH"
echo "$HEALTH" | jq -e '.embedder=="text-embedding-v4" and .narrator=="qwen-plus" and (.judge|type)=="string" and (.judge|startswith("fake-")|not) and .embedDim==1024' >/dev/null \
  || fail "/health is not real Qwen (got: $HEALTH) — the box may have restarted WITHOUT DASHSCOPE_API_KEY (reverts to fake-hash-embedder)"
HEALTH_C=$(echo "$HEALTH" | jq -c .)
JUDGE_MODEL=$(echo "$HEALTH" | jq -r '.judge')

# The live count the Explorer UI renders as a badge (proves persistence, not a mock).
COUNT_JSON=$(curl -fsS -m 25 "$BASE/memory/count") || fail "/memory/count failed — box unreachable"
echo "count: $COUNT_JSON"
echo "$COUNT_JSON" | jq -e '(.count|type)=="number" and .count>=1' >/dev/null \
  || fail "/memory/count is not a real count (got: $COUNT_JSON)"
COUNT=$(echo "$COUNT_JSON" | jq -r '.count')
COUNT_C=$(echo "$COUNT_JSON" | jq -c .)

# ------------------------------------------------- SESSION A · ingest (cross-session)
# Workforce-cost example (ONE of many the agents remember): bank net €10,000 vs true
# employer cost €15,800. Universal financial terms only, no country/authority names.
EVENT=$(cat <<JSON
{"event":{"event_id":"evt-${RUN}","company":"${COMPANY}","period":"2026-05","employee_count":2,"bank_net_total":10000,"gross_total":13000,"employer_social_security_total":2800,"employee_social_security_total":1000,"tax_withheld_total":2000,"employer_cost_total":15800,"cost_gap_amount":5800,"cost_gap_pct":58.0,"off_bank_cost":5800,"employees":[{"employee_id":"E-01","name":"Elena Novak","gross":8000,"employee_social_security":600,"tax":1600,"net":5800,"employer_social_security":1800,"employer_cost":9800},{"employee_id":"E-02","name":"David Chen","gross":5000,"employee_social_security":400,"tax":400,"net":4200,"employer_social_security":1000,"employer_cost":6000}],"linked_docs":["doc-bank-1","doc-reg-1"]}}
JSON
)
INGEST=$(curl -fsS -m 60 -X POST "$BASE/ingest" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$EVENT") \
  || fail "/ingest (Session A) failed"
echo "ingest: $INGEST"
echo "$INGEST" | jq -e '.written>=1' >/dev/null || fail "/ingest wrote no memories (got: $INGEST)"
WRITTEN=$(echo "$INGEST" | jq -r '.written')
INGEST_C=$(echo "$INGEST" | jq -c '{written, ids: (.ids[0:2] + ["..."])}')

# ------------------------------------------------- SESSION B · recall (x2)  [Explorer UI]
# This is precisely what the Explorer UI at BASE/ does: company + question -> POST /recall.
# Recall is filtered to kind="payroll_event" (event summary + per-employee lines): the
# universal financial facts, no country/authority names in the grounding.
#
# hybrid:false  →  PURE DENSE (cosine ANN) recall, on purpose. The demo VISUALISES and
# HARD-CHECKS a real cosine similarity, and dense recall is the path whose `hit.score`
# IS that cosine similarity (score = 1 - cosine_distance). The product-default recall
# path is HYBRID (dense + lexical fused with Reciprocal Rank Fusion + rerank), whose
# scores are RANK-based, not cosine — see BENCHMARK.md; the DEMO reports the honest,
# human-meaningful metric its own narration promises.
Q1="What was the true cost of employing our team last month compared with what actually left the bank account?"
R1=$(curl -fsS -m 90 -X POST "$BASE/recall" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q1" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3, hybrid:false}')") \
  || fail "/recall (Session B, Q1) failed"
echo "recall1: $R1"
echo "$R1" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0 and (.hits[0].score>0.35)' >/dev/null \
  || fail "/recall Q1 is not a real grounded qwen-plus answer over real memory (got: $(echo "$R1" | jq -c '{modelId, hits:(.hits|length), top:(.hits[0].score)}'))"
A1=$(echo "$R1" | jq -r '.answer' | tr '\n' ' ' | tr -s ' ')
[ -n "$A1" ] || fail "/recall Q1 returned an empty answer"
SCORES1=$(echo "$R1" | jq -r '.citations[] | "  \(.marker) kind=\(.kind)  cosine=\(((.score*1000)|round)/1000)  ref=\(.sourceRef)"')

Q2="What was the total cost of employing Elena last month?"
R2=$(curl -fsS -m 90 -X POST "$BASE/recall" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$Q2" --arg c "$COMPANY" '{question:$q, company:$c, kind:"payroll_event", limit:3, hybrid:false}')") \
  || fail "/recall (Session B, Q2) failed"
echo "recall2: $R2"
echo "$R2" | jq -e '.modelId=="qwen-plus" and (.hits|length)>0 and (.hits[0].score>0.35)' >/dev/null \
  || fail "/recall Q2 is not a real grounded qwen-plus answer over real memory (got: $(echo "$R2" | jq -c '{modelId, hits:(.hits|length), top:(.hits[0].score)}'))"
A2=$(echo "$R2" | jq -r '.answer' | tr '\n' ' ' | tr -s ' ')
[ -n "$A2" ] || fail "/recall Q2 returned an empty answer"

# POSITIONING guard — the on-screen recalled answers must be domain-neutral.
if printf '%s\n%s\n' "$R1" "$R2" | grep -iqE "$FORBIDDEN"; then
  fail "a recalled answer contains a forbidden positioning term (/$FORBIDDEN/) — universal financial terms only"
fi

# ============================================================ DIFFERENTIATOR
# Self-auditing memory: two SEPARATE write events remember the SAME record with a
# DIFFERENT value (a later reconciliation "corrected" it). A plain recall would
# silently return one; /consistency DETECTS the disagreement and RECOMMENDS which
# side to trust (importance -> source-authority -> recency). The audit is read-only.
audit_event() { # $1 = employer_cost_total
cat <<JSON
{"event":{"event_id":"evt-audit-${RUN}","company":"${AUDIT_COMPANY}","period":"2026-05","employee_count":2,"bank_net_total":10000,"gross_total":13000,"employer_social_security_total":2800,"employee_social_security_total":1000,"tax_withheld_total":2000,"employer_cost_total":$1,"cost_gap_amount":5800,"cost_gap_pct":58.0,"off_bank_cost":5800,"employees":[{"employee_id":"E-01","name":"Elena Novak","gross":8000,"employee_social_security":600,"tax":1600,"net":5800,"employer_social_security":1800,"employer_cost":9800},{"employee_id":"E-02","name":"David Chen","gross":5000,"employee_social_security":400,"tax":400,"net":4200,"employer_social_security":1000,"employer_cost":6000}],"linked_docs":["doc-bank-1","doc-reg-1"]}}
JSON
}

# Write event #1 — employer cost recorded as €18,000.
curl -fsS -m 60 -X POST "$BASE/ingest" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$(audit_event 18000)" >/dev/null \
  || fail "/ingest (audit write #1) failed"
# Write event #2 — a LATER session records €19,000 for the SAME event.
curl -fsS -m 60 -X POST "$BASE/ingest" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$(audit_event 19000)" >/dev/null \
  || fail "/ingest (audit write #2) failed"

CONS=$(curl -fsS -m 60 -X POST "$BASE/consistency" "${AUTH[@]}" -H 'Content-Type: application/json' \
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
# The non-recommended (earlier) value, for a date-free recency rationale (two writes
# seconds apart render the SAME day twice, which reads as a bug at the hero moment).
CONS_OTHER=$(echo "$CONS" | jq -r '.contradictions[0] as $c | ($c.values|map(.value)|map(select(.!=$c.resolution.recommendedValue))|.[0])')

# ================================================= SEMANTIC (meaning-level) AUDIT
# The rule-based audit above compares metadata FIELDS. It is blind to two memories
# that oppose each other in MEANING while sharing no comparable key ("vendor pays on
# time" vs "vendor is chronically late"). The seeded demo (/demo/seed — idempotent,
# free offline extractor) plants exactly that pair under "Northwind Trading" as
# `insight` memories; POST /consistency/semantic embeds each, keeps same-subject
# pairs by cosine, and asks the configured live Qwen judge whether they contradict. Scoped
# to kind=insight so it is fast and returns the single meaning-level finding. A box
# on the offline Fakes (fake-polarity-judge) or without the seed FAILS the jq gate.
SEM_COMPANY="Northwind Trading"
curl -fsS -m 60 -X POST "$BASE/demo/seed" "${AUTH[@]}" >/dev/null \
  || fail "/demo/seed failed — cannot seed the meaning-level contradiction pair"
SEM=$(curl -fsS -m 90 -X POST "$BASE/consistency/semantic" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "$SEM_COMPANY" '{company:$c, kind:"insight"}')") \
  || fail "/consistency/semantic (meaning-level self-audit) failed"
echo "semantic: $SEM"
echo "$SEM" | jq -e --arg model "$JUDGE_MODEL" '
  .ok==false
  and (.semanticContradictions|length)>=1
  and (.semanticContradictions[0].judge.model==$model)
  and (.semanticContradictions[0].resolution!=null)' >/dev/null \
  || fail "/consistency/semantic did not flag the seeded meaning-level contradiction via the configured live Qwen judge (got: $(echo "$SEM" | jq -c '{ok, n:(.semanticContradictions|length), judge:.semanticContradictions[0].judge}'))"
# The two opposing memories, earliest first (session ordering), for the transcript.
SEM_A=$(echo "$SEM" | jq -r '.semanticContradictions[0].memories[0].content' | tr '\n' ' ' | tr -s ' ')
SEM_B=$(echo "$SEM" | jq -r '.semanticContradictions[0].memories[1].content' | tr '\n' ' ' | tr -s ' ')
SEM_SIM=$(echo "$SEM" | jq -r '.semanticContradictions[0] | ((.similarity*1000)|round)/1000')
SEM_CONF=$(echo "$SEM" | jq -r '.semanticContradictions[0].judge.confidence')
# POSITIONING guard — the on-screen semantic memories must be domain-neutral too.
if printf '%s\n%s\n' "$SEM_A" "$SEM_B" | grep -iqE "$FORBIDDEN"; then
  fail "a semantic-audit memory contains a forbidden positioning term (/$FORBIDDEN/) — universal financial terms only"
fi

# ---------------------------------------------------- build the transcript
# Time prefix = screencast-local seconds (matches scripts/captions.txt + the VO).
# Lines are the REAL captured values. Answers are ONE logical line each (newlines
# stripped) so they appear atomically at their anchor and cannot overflow/reorder.
: > "$OUT"
t() { printf '%s\n' "$1" >> "$OUT"; }        # timed line ("<sec> text")
blk() { printf '%s\n' "$1" >> "$OUT"; }      # untimed block (inherits prev+0.4s)

# --- OPEN (problem) ---
t "0.0 \$ # Archon MemoryAgent  ·  persistent, queryable memory across sessions"
t "2.5 \$ # An agent that forgets across sessions is useless for recurring back-office work."
t "4.5 \$ # The ONLY shared state across sessions is pgvector on Alibaba Cloud."
# --- PROOF (real Qwen + live count badge) ---
t "6.0 \$ # ---- PROOF · real Qwen, live on Alibaba Cloud ----"
t "7.0 \$ curl -s $BASE/health"
t "8.5   $HEALTH_C"
t "9.5 → embedder=text-embedding-v4 · narrator=qwen-plus · 1024-dim  (REAL Qwen, not a stub)"
t "12.0 \$ curl -s $BASE/memory/count"
t "13.5   $COUNT_C"
t "14.5 → $COUNT durable memories in pgvector — the Explorer UI's live count badge"
# --- WHAT IT IS ---
t "16.5 \$ # ---- WHAT IT IS ----"
t "18.0 \$ # Every fused event, validation finding and narrated insight is embedded with"
t "20.0 \$ # text-embedding-v4 and written to pgvector on Alibaba — durable, not in-process."
# --- ARCHITECTURE ---
t "24.5 \$ # ---- ARCHITECTURE · hybrid retrieval ----"
t "26.0 \$ # embed → pgvector → dense + PostgreSQL full-text (RRF) → bounded listwise qwen-plus rerank → grounded answer"
t "29.0 \$ # Queryable by MEANING across sessions — not string match, not an in-process cache."
# --- LIVE DEMO · Explorer UI · SESSION A ---
t "31.5 \$ # ---- LIVE DEMO · Explorer UI at $BASE/  ----"
t "34.0 \$ # SESSION A — an agent fuses bank + register + payslips into ONE financial event"
t "36.0 \$ # (invoices, cash positions, workforce cost — one example among many) and commits it."
t "38.5 \$ curl -X POST $BASE/ingest -d @event.json"
t "39.5   # event: company=\"$COMPANY\"  ·  employer cost €15,800  ·  bank net €10,000  ·  gap €5,800"
t "41.0   $INGEST_C"
t "42.0 → $WRITTEN memories embedded with text-embedding-v4 → written to pgvector on Alibaba"
t "43.5 \$ # SESSION A ENDS — the client disconnects; nothing stays in process memory."
# --- SESSION B · recall Q1 (the Explorer round-trip) ---
t "45.5 \$ # ---- SESSION B · Explorer UI · a fresh, separate client ----"
t "47.0 \$ # In the browser at $BASE/ , type a company and a question:"
t "49.0 \$ curl -X POST $BASE/recall \\\\"
t "50.0   -d '{\"question\":\"$Q1\", \"company\":\"$COMPANY\", \"kind\":\"payroll_event\"}'"
t "52.0 \$ # Qwen embeds the question → cosine ANN over pgvector → qwen-plus grounds the answer"
t "54.5 ANSWER (qwen-plus · grounded in memory written during Session A):"
t "55.5   $A1"
t "59.5 Recalled by MEANING — real cosine similarity over pgvector (higher = closer):"
blk "$SCORES1"
t "64.0 >> A memory WRITTEN in Session A was RETRIEVED in Session B — cross-session persistence."
# --- SESSION B · recall Q2 ---
t "66.0 \$ # ---- SESSION B · a second, different question ----"
t "67.5 \$ # Memory is genuinely QUERYABLE, not a canned reply. Ask something else:"
t "69.0 \$ curl -X POST $BASE/recall -d '{\"question\":\"$Q2\", \"company\":\"…\", \"kind\":\"payroll_event\"}'"
t "71.0 ANSWER (qwen-plus):"
t "72.0   $A2"
t "75.0 >> Same persistent memory · a new query · a new grounded answer (real cosine over pgvector)."
# --- DIFFERENTIATOR · self-auditing memory ---
t "77.0 \$ # ---- ⭐ THE DIFFERENTIATOR · memory that AUDITS ITSELF ----"
t "79.0 \$ # Two SEPARATE sessions wrote ONE record with a DIFFERENT value."
t "81.0 \$ curl -X POST $BASE/ingest -d @a.json   # write #1: employer cost €18,000"
t "83.0 \$ curl -X POST $BASE/ingest -d @a.json   # write #2 (a LATER session): €19,000"
t "85.0 \$ # Pinned Mem0 dir() probe found no separately named public contradiction/resolution method. Archon audits read-only:"
t "88.0 \$ curl -X POST $BASE/consistency -d '{\"company\":\"$AUDIT_COMPANY\"}'"
t "90.5 → CONTRADICTION on '$CONS_SUBJECT' · attribute employer_cost_total · $CONS_VALS"
t "94.5 → RESOLUTION (read-only recommender): trust $CONS_REC  [rule=$CONS_RULE · confidence=$CONS_CONF]"
t "98.5   Rationale: the more recent write ($CONS_REC) supersedes the earlier value ($CONS_OTHER)."
t "102.5 >> DETECTED its own cross-session disagreement · RECOMMENDED read-only · human action is separate."
t "106.5   Measured: 5/5 field issues · 0 false positives · 4/4 declared-policy conformance"
# --- SEMANTIC · meaning-level self-audit (the class the rule-based audit is blind to) ---
t "110.0 \$ # ---- ⭐ MEANING-LEVEL self-audit · fields match nothing; the meaning opposes ----"
t "112.0 \$ # Two memories OPPOSE in MEANING with NO comparable field — the prose is the only signal:"
t "114.0   A: $SEM_A"
t "116.0   B: $SEM_B"
t "118.0 \$ curl -X POST $BASE/consistency/semantic -d '{\"company\":\"$SEM_COMPANY\", \"kind\":\"insight\"}'"
t "120.5 → embed each → same subject by cosine ($SEM_SIM) → LIVE $JUDGE_MODEL judge: CONTRADICT [confidence=$SEM_CONF]"
t "123.5 >> Caught what the field-level audit CANNOT see · same read-only recommendation."
t "126.0 \$ # Every op — recall · ingest · audit · count — is also an MCP tool (audit takes semantic:true)."
# --- MEASURED (retrieval) ---
t "129.0 \$ # ---- MEASURED · labelled datasets (npm run bench) ----"
t "131.0   Frozen fixture: reranked-hybrid beats dense — Recall@3 90.0% → 96.7% · MRR 0.883 → 0.911"
t "135.0   Number checks: gold-figure hit 11/11 · complete euro traceability 10/11"
# --- CLOSE · deployment ---
t "138.5 \$ # ---- LIVE · Alibaba Cloud ----"
t "140.5   Live URL :  $BASE/           (Explorer UI · public · reachable now)"
t "142.5   Compute  :  Alibaba Cloud ECS · ecs.e-c1m2.large · ap-southeast-1 (Singapore)"
t "145.0   Memory   :  pgvector container on the ECS box · HNSW cosine · vector(1024)"
t "147.5   Models   :  Qwen text-embedding-v4  +  qwen-plus  (Model Studio / DashScope)"
t "150.0   Source   :  github.com/upgradedev/archon-qwen-memoryagent   ·   MIT"
t "153.0 >> Self-auditing · persistent · queryable · across sessions."
t "156.5 >> Real Qwen on Alibaba Cloud. Measured, not a wrapper."

echo "== transcript written to $OUT =="
cat "$OUT"
