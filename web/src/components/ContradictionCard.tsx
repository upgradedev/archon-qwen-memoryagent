import type { Contradiction } from "../types";
import { formatValue, formatDate, formatConfidence } from "../format";

// Renders one cross-session contradiction: the record + attribute, each
// conflicting value with the write event (source + timestamp) that carries it,
// and the resolution RECOMMENDATION. The recommended value is highlighted; the
// card is explicit that the audit never mutates memory.
export function ContradictionCard({ c }: { c: Contradiction }) {
  const winnerId = c.resolution.recommendedMemoryId;
  return (
    <div className="contradiction">
      <div className="subject">
        record <b>{c.subject}</b> · attribute <span className="attr">{c.attribute}</span>
      </div>

      <div className="values">
        {c.values.map((v) => {
          const win = v.memoryId === winnerId;
          return (
            <div className={`value-chip${win ? " win" : ""}`} key={v.memoryId}>
              <div className="v">{formatValue(v.value)}</div>
              <div className="meta">
                {v.sourceRef ?? "—"} · {formatDate(v.createdAt)}
                {win ? " · recommended" : ""}
              </div>
            </div>
          );
        })}
      </div>

      <div className="resolution">
        <div className="rec">
          Recommendation: trust <b>{formatValue(c.resolution.recommendedValue)}</b>
          <span className="rule-pill">
            {c.resolution.rule} · {formatConfidence(c.resolution.confidence)}
          </span>
        </div>
        <div className="rationale">{c.resolution.rationale}</div>
        <div className="no-mutate">
          <span className="lock">&#128274;</span>
          Never mutates memory — this is a recommendation, not a write.
        </div>
      </div>
    </div>
  );
}
