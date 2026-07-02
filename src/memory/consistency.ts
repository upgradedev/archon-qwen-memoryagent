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
