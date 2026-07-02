// Self-auditing memory-consistency layer — the agent that checks its OWN memory.
//
// A cross-session MemoryAgent accumulates facts written by many separate write
// events (different processes, different sessions, over time). Nothing stops two
// of those writes from DISAGREEING: session A stores "invoice INV-2043 total
// €18,400", a later session B stores "€18,900" for the same invoice. A plain
// recall would just hand back whichever ranked higher and stay silent about the
// conflict. That is exactly the failure mode this module exists to catch.
//
// `auditConsistency` groups a set of memories by the RECORD they describe and
// flags two memory-native problems:
//
//   CONTRADICTION — two memories describing the SAME record assign DIFFERENT
//                   values to the SAME attribute (e.g. two stored totals for one
//                   invoice). Because each memory is a distinct write event with
//                   its own timestamp, a contradiction means two sessions
//                   remembered the record differently.
//   ABSENCE       — a memory explicitly references another record (metadata.refs)
//                   that has NO memory in the audited set — a dangling reference,
//                   i.e. an expected counterpart the agent never actually stored.
//
// This is a PURE function over generic memory rows (no DB, no domain rules — it
// is NOT the financial R1–R4 validator). It runs identically over InMemoryStore
// rows in tests and over the pgvector rows the production store returns, so the
// "self-auditing memory" claim is measured on the same engine that ships.
//
// It examines ACTIVE memories only (the caller passes non-superseded rows), so a
// contradiction is caught BEFORE consolidation might collapse the two near-
// identical rows into one and hide the disagreement.

// The minimal, domain-neutral view of a memory the audit needs. Every field maps
// 1:1 to a column the store already has — no schema change, no new column.
export interface AuditMemory {
  id: string;
  kind: string;
  company: string;
  period: string | null;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string; // ISO — the write-event timestamp (our "session" signal)
  // Explicit 0..1 salience — the top-level `importance` column the store persists
  // (0.5 default). Surfaced here so the resolver's importance rule fires on REAL
  // ingested memories, not only on ones with importance hand-placed in metadata.
  importance?: number | null;
}

// A RECOMMENDATION for which side of a contradiction to trust. This is a
// recommender, NOT ground truth: the audit cannot know which write was correct,
// only which one a defensible, domain-neutral policy would prefer. It NEVER
// mutates memory — the caller decides what to do with the recommendation.
//
// The policy is a fixed priority ladder over signals ALREADY present on the
// memories (no new data, no finance rulebook):
//   1. importance       — an explicit `metadata.importance` (0..1 salience) is the
//                         strongest signal: a memory a human/agent flagged as
//                         important outranks a later write with none.
//   2. source-authority — a STRUCTURED record (`document`/`payroll_event`/
//                         `validation`) is a more authoritative source of a RAW
//                         value than a DERIVED narrative (`insight`). Conservative
//                         and overridable (see `AuditOptions.kindAuthority`).
//   3. recency          — the DEFAULT: the later write wins (the newest session
//                         presumably corrected the older one).
export interface Resolution {
  recommendedMemoryId: string; // a real memory id carrying the winning value
  recommendedValue: unknown; // the value the policy recommends trusting
  rule: "recency" | "importance" | "source-authority";
  // Heuristic ordinal confidence in [0,1] — NOT a calibrated probability. It
  // reflects how cleanly the winning signal separated the sides (bigger gap /
  // stronger signal → higher), and is deliberately modest for recency (a later
  // write is only a *default*, it can itself be the mistake).
  confidence: number;
  rationale: string; // one-line human-readable justification
}

// One conflicting attribute across two-or-more memories of the same record.
export interface Contradiction {
  type: "contradiction";
  subject: string; // the record all these memories describe
  attribute: string; // the metadata field they disagree on
  // Each distinct value and the memory (write event) that carries it.
  values: Array<{
    memoryId: string;
    sourceRef: string | null;
    value: unknown;
    createdAt: string;
  }>;
  // A recommendation for which value to trust (recommender, not ground truth).
  resolution: Resolution;
}

// A referenced record that no memory in the audited set actually stores.
export interface Absence {
  type: "absence";
  subject: string; // the referenced-but-missing record
  referencedBy: Array<{ memoryId: string; sourceRef: string | null }>;
}

export interface ConsistencyReport {
  audited: number; // memories examined
  subjects: number; // distinct records seen
  contradictions: Contradiction[];
  absences: Absence[];
  ok: boolean; // true ⇔ no findings
}

export interface AuditOptions {
  // Absolute tolerance for treating two numbers as "the same value" (rounding /
  // float noise). Two totals within this band are NOT a contradiction.
  numericTolerance?: number;
  // Optional override for the source-authority ranking over memory `kind`. Higher
  // = more authoritative for a RAW attribute value. Anything not in the map falls
  // back to the neutral/structured rank; see DEFAULT_KIND_AUTHORITY.
  kindAuthority?: Record<string, number>;
}

// Metadata keys that name the record itself or its cross-references — they are
// identity, not attributes to compare, so they never count as contradictions.
const RESERVED_KEYS = new Set(["record", "refs"]);

// The record a memory is about. Deterministic and SPECIFIC on purpose:
//   1. an explicit `metadata.record` (a caller-declared logical record id), else
//   2. the memory's `sourceRef` (the originating row id — e.g. `evt-1` for an
//      event summary, `evt-1:E-03` for one employee line: correctly DISTINCT).
// We deliberately do NOT fall back to company::period — that would collapse
// unrelated records (two employees in one event both have a `net`) into one
// subject and manufacture false contradictions. A memory with no record key is
// un-auditable for contradictions and is skipped (counted, never flagged).
export function subjectKey(m: AuditMemory): string | null {
  const rec = m.metadata?.["record"];
  if (typeof rec === "string" && rec.length > 0) return rec;
  if (typeof rec === "number") return String(rec);
  if (m.sourceRef && m.sourceRef.length > 0) return m.sourceRef;
  return null;
}

// Compare two attribute values for equality. Numbers use an absolute tolerance;
// everything else uses strict string-normalized equality.
function valuesAgree(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= tol;
  }
  if (typeof a === "number" || typeof b === "number") {
    // one numeric, one not → compare by string form (e.g. 18400 vs "18400")
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Comparable attributes of a memory: its flat metadata entries minus the
// reserved identity keys, keeping only JSON-scalar values (number/string/bool).
function attributesOf(m: AuditMemory): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const md = m.metadata;
  if (!md) return out;
  for (const [k, v] of Object.entries(md)) {
    if (RESERVED_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") out.set(k, v);
  }
  return out;
}

// ── Resolution (recommender) ────────────────────────────────────────────────
// Conservative, OVERRIDABLE authority ranking over the memory `kind` enum.
// Grounded in the data model: `document` / `payroll_event` / `validation` are
// STRUCTURED, system-of-record memories, whereas `insight` is a DERIVED narrative
// the agent wrote *about* other memories. For a RAW attribute value the structured
// record is the more authoritative source than a narrated derivation. We ONLY ever
// demote a memory we KNOW is derived (`insight`); every other/unknown kind keeps
// the neutral structured rank, so the audit never invents authority it can't
// justify. Callers can supply their own map via `AuditOptions.kindAuthority`.
const STRUCTURED_AUTHORITY = 2;
const DEFAULT_KIND_AUTHORITY: Record<string, number> = { insight: 1 };

function authorityOf(kind: string, map: Record<string, number>): number {
  const v = map[kind];
  return typeof v === "number" ? v : STRUCTURED_AUTHORITY;
}

// The explicit salience a memory carries. Prefers the top-level `importance`
// COLUMN the store persists (so the rule fires on real ingested memories — the
// production path writes salience there, e.g. the 0.9 hidden-cost insight), and
// falls back to a caller-placed `metadata.importance` for backward-compat.
// Returns null when absent/non-numeric (→ "no signal").
function importanceOf(m: AuditMemory): number | null {
  if (typeof m.importance === "number" && Number.isFinite(m.importance)) return m.importance;
  const v = m.metadata?.["importance"];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const MS_PER_DAY = 86_400_000;

// A distinct-value cluster: the value plus every memory (write event) asserting it.
interface ValueCluster {
  value: unknown;
  memories: AuditMemory[];
}

function latestOf(mems: AuditMemory[]): AuditMemory {
  return [...mems].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1
  )[0]!;
}

// Recommend which distinct value to trust, using the fixed priority ladder
// (importance → source-authority → recency). Pure; a recommender, not truth.
export function resolveContradiction(
  clusters: ValueCluster[],
  kindAuthority: Record<string, number> = DEFAULT_KIND_AUTHORITY
): Resolution {
  // Per-cluster aggregates of each signal + the representative memory carrying it.
  const agg = clusters.map((c) => {
    const impCarrier = c.memories
      .filter((m) => importanceOf(m) !== null)
      .sort((a, b) => importanceOf(b)! - importanceOf(a)!)[0];
    const authCarrier = [...c.memories].sort(
      (a, b) => authorityOf(b.kind, kindAuthority) - authorityOf(a.kind, kindAuthority)
    )[0]!;
    const latest = latestOf(c.memories);
    return {
      value: c.value,
      importance: impCarrier ? importanceOf(impCarrier) : null,
      importanceCarrier: impCarrier ?? null,
      authority: authorityOf(authCarrier.kind, kindAuthority),
      authorityCarrier: authCarrier,
      latest,
    };
  });

  // ── Rule 1: importance — a memory flagged with higher salience wins. ─────────
  const withImp = agg.filter((a) => a.importance !== null);
  if (withImp.length > 0) {
    const sorted = [...agg].sort((a, b) => (b.importance ?? -1) - (a.importance ?? -1));
    const top = sorted[0]!;
    const second = sorted[1]!;
    const margin = (top.importance ?? -1) - (second.importance ?? -1);
    if (top.importance !== null && margin >= 0.05) {
      const win = top.importanceCarrier!;
      const conf = clamp(0.6 + Math.min(0.3, margin * 0.5), 0, 0.95);
      return {
        recommendedMemoryId: win.id,
        recommendedValue: top.value,
        rule: "importance",
        confidence: round2(conf),
        rationale:
          `Memory ${win.id} carries higher importance (${fmt(top.importance)} vs ` +
          `${second.importance === null ? "none" : fmt(second.importance)}); ` +
          `explicit salience outranks a later write.`,
      };
    }
  }

  // ── Rule 2: source-authority — a structured record outranks a derived note. ──
  const sortedAuth = [...agg].sort((a, b) => b.authority - a.authority);
  const topAuth = sortedAuth[0]!;
  const secondAuth = sortedAuth[1]!;
  if (topAuth.authority > secondAuth.authority) {
    const win = topAuth.authorityCarrier;
    return {
      recommendedMemoryId: win.id,
      recommendedValue: topAuth.value,
      rule: "source-authority",
      confidence: 0.75,
      rationale:
        `Structured '${win.kind}' record outranks derived '${secondAuth.authorityCarrier.kind}' ` +
        `for a raw value; source authority overrides recency.`,
    };
  }

  // ── Rule 3: recency (default) — the later write wins. ────────────────────────
  const sortedRec = [...agg].sort((a, b) =>
    a.latest.createdAt < b.latest.createdAt
      ? 1
      : a.latest.createdAt > b.latest.createdAt
        ? -1
        : a.latest.id < b.latest.id // timestamp tie → deterministic by id
          ? -1
          : 1
  );
  const win = sortedRec[0]!;
  const runnerUp = sortedRec[1]!;
  const tie = win.latest.createdAt === runnerUp.latest.createdAt;
  const gapDays = tie
    ? 0
    : (Date.parse(win.latest.createdAt) - Date.parse(runnerUp.latest.createdAt)) / MS_PER_DAY;
  const conf = tie ? 0.4 : clamp(0.5 + Math.min(0.35, (gapDays / 30) * 0.35), 0, 0.85);
  return {
    recommendedMemoryId: win.latest.id,
    recommendedValue: win.value,
    rule: "recency",
    confidence: round2(conf),
    rationale: tie
      ? `Writes share a timestamp; no stronger signal available — defaulting to ` +
        `memory ${win.latest.id} (deterministic tie-break). Low confidence.`
      : `Later write (${win.latest.createdAt.slice(0, 10)}) supersedes the earlier ` +
        `value ${fmt(runnerUp.value)} (${runnerUp.latest.createdAt.slice(0, 10)}); ` +
        `recency is the default tie-breaker.`,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmt(v: unknown): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

// Audit a set of memories for cross-session contradictions and dangling
// references. Pure — no I/O. The caller supplies ACTIVE (non-superseded) rows.
export function auditConsistency(
  memories: AuditMemory[],
  opts: AuditOptions = {}
): ConsistencyReport {
  const tol = opts.numericTolerance ?? 0.5;

  // Group memories by the record they describe.
  const bySubject = new Map<string, AuditMemory[]>();
  const presentSubjects = new Set<string>();
  for (const m of memories) {
    const s = subjectKey(m);
    if (!s) continue;
    presentSubjects.add(s);
    (bySubject.get(s) ?? bySubject.set(s, []).get(s)!).push(m);
  }

  // ── Contradictions: same subject, same attribute, disagreeing values ────────
  const contradictions: Contradiction[] = [];
  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;

    // Collect, per attribute, the (value, memory) carriers across the group.
    const byAttr = new Map<string, Array<{ m: AuditMemory; value: unknown }>>();
    for (const m of group) {
      for (const [attr, value] of attributesOf(m)) {
        (byAttr.get(attr) ?? byAttr.set(attr, []).get(attr)!).push({ m, value });
      }
    }

    for (const [attr, carriers] of byAttr) {
      // Only shared attributes (≥2 memories assert it) can contradict.
      if (carriers.length < 2) continue;
      // Do the carriers disagree? Cluster into distinct values.
      const distinct: Array<{ value: unknown; carriers: typeof carriers }> = [];
      for (const c of carriers) {
        const bucket = distinct.find((d) => valuesAgree(d.value, c.value, tol));
        if (bucket) bucket.carriers.push(c);
        else distinct.push({ value: c.value, carriers: [c] });
      }
      if (distinct.length < 2) continue; // all agree → consistent

      const resolution = resolveContradiction(
        distinct.map((d) => ({ value: d.value, memories: d.carriers.map((c) => c.m) })),
        opts.kindAuthority ?? DEFAULT_KIND_AUTHORITY
      );

      contradictions.push({
        type: "contradiction",
        subject,
        attribute: attr,
        values: distinct
          .map((d) => {
            // Representative write event per distinct value (earliest write).
            const rep = [...d.carriers].sort((a, b) =>
              a.m.createdAt < b.m.createdAt ? -1 : a.m.createdAt > b.m.createdAt ? 1 : 0
            )[0]!;
            return {
              memoryId: rep.m.id,
              sourceRef: rep.m.sourceRef,
              value: d.value,
              createdAt: rep.m.createdAt,
            };
          })
          .sort((a, b) =>
            a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
          ),
        resolution,
      });
    }
  }

  // ── Absences: a referenced record with no memory of its own ─────────────────
  const referencedBy = new Map<string, Array<{ memoryId: string; sourceRef: string | null }>>();
  for (const m of memories) {
    const refs = m.metadata?.["refs"];
    if (!Array.isArray(refs)) continue;
    for (const r of refs) {
      const key = typeof r === "number" ? String(r) : typeof r === "string" ? r : null;
      if (!key) continue;
      if (presentSubjects.has(key)) continue; // the referenced record exists
      (referencedBy.get(key) ?? referencedBy.set(key, []).get(key)!).push({
        memoryId: m.id,
        sourceRef: m.sourceRef,
      });
    }
  }
  const absences: Absence[] = [...referencedBy.entries()].map(([subject, refs]) => ({
    type: "absence",
    subject,
    referencedBy: refs,
  }));

  // Deterministic ordering for stable output / tests.
  contradictions.sort((a, b) =>
    a.subject !== b.subject
      ? a.subject < b.subject ? -1 : 1
      : a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0
  );
  absences.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));

  return {
    audited: memories.length,
    subjects: bySubject.size,
    contradictions,
    absences,
    ok: contradictions.length === 0 && absences.length === 0,
  };
}
