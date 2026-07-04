import { useState } from "react";
import type { ConsistencyReport } from "../types";
import { postConsistency } from "../api";
import { ContradictionCard } from "./ContradictionCard";
import { DEMO_CONSISTENCY } from "../demo";

interface Props {
  live: boolean;
  onLiveResult: (wasLive: boolean, reason?: string) => void;
}

// Panel 2 — Self-audit. Button → POST /consistency. Renders each cross-session
// contradiction and its resolution recommendation. Read-only: the audit scans
// memory and recommends — it never mutates.
export function AuditPanel({ live, onLiveResult }: Props) {
  const [report, setReport] = useState<ConsistencyReport>(DEMO_CONSISTENCY);
  const [loading, setLoading] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);
  const [ran, setRan] = useState(true); // demo report is shown by default

  async function run() {
    if (!live) {
      setReport(DEMO_CONSISTENCY);
      setFellBack(null);
      setRan(true);
      return;
    }
    setLoading(true);
    const res = await postConsistency();
    setReport(res.data);
    setFellBack(res.live ? null : res.reason);
    onLiveResult(res.live, res.live ? undefined : res.reason);
    setRan(true);
    setLoading(false);
  }

  const contradictions = report.contradictions ?? [];

  return (
    <section className="card">
      <h2>Self-audit — memory consistency</h2>
      <p className="hint">
        A read-only, full-scope scan for cross-session contradictions — two write
        events that remembered the same record differently.
      </p>

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "Auditing…" : "Run self-audit"}
        </button>
        {fellBack && <span className="notice">&#9888; {fellBack}</span>}
      </form>

      {ran && (
        <>
          <div className={`audit-banner ${report.ok ? "clean" : "flag"}`}>
            {report.ok ? (
              <span>
                &#10003; No contradictions across {report.audited} memories ({report.subjects}{" "}
                records).
              </span>
            ) : (
              <span>
                &#9888; {contradictions.length} contradiction
                {contradictions.length === 1 ? "" : "s"} across {report.audited} memories (
                {report.subjects} records). Each carries a resolution recommendation —
                the audit never mutates memory.
              </span>
            )}
          </div>

          {contradictions.map((c, i) => (
            <ContradictionCard c={c} key={i} />
          ))}
        </>
      )}
    </section>
  );
}
