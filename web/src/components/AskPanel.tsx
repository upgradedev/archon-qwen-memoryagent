import { useState } from "react";
import type { RecallResponse } from "../types";
import { postRecall } from "../api";
import { formatScore } from "../format";
import { ContradictionCard } from "./ContradictionCard";
import { DEMO_RECALL } from "../demo";

interface Props {
  live: boolean; // parent's Live toggle
  onLiveResult: (wasLive: boolean, reason?: string) => void;
}

const DEFAULT_Q = "What was ByteCraft's true workforce cost, and does it match the bank transfer?";

// Highlight [n] citation markers inline in the grounded answer.
function renderAnswer(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) =>
    /^\[\d+\]$/.test(part) ? (
      <span className="cite" key={i}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// Panel 1 — Ask (grounded recall). Query → POST /recall {hybrid:true}. Renders the
// grounded, cited answer; the recalled memories (content + cosine score); and the
// best-effort self-audit over those memories, when the response carries one.
export function AskPanel({ live, onLiveResult }: Props) {
  const [question, setQuestion] = useState(DEFAULT_Q);
  const [result, setResult] = useState<RecallResponse>(DEMO_RECALL);
  const [loading, setLoading] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    if (!live) {
      // Demo mode — always render the canned recall, no network.
      setResult(DEMO_RECALL);
      setFellBack(null);
      return;
    }
    setLoading(true);
    const res = await postRecall(question.trim());
    setResult(res.data);
    setFellBack(res.live ? null : res.reason);
    onLiveResult(res.live, res.live ? undefined : res.reason);
    setLoading(false);
  }

  const auditFindings = result.consistency?.contradictions ?? [];

  return (
    <section className="card">
      <h2>Ask — grounded recall</h2>
      <p className="hint">
        Semantic recall over persistent memory, answered by {result.modelId} with inline
        citations to the exact memories used.
      </p>

      <form className="ask-form" onSubmit={ask}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question grounded in the agent's memory…"
          aria-label="Question"
        />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "Recalling…" : "Ask"}
        </button>
      </form>

      {fellBack && (
        <span className="notice">&#9888; {fellBack}</span>
      )}

      <div className="answer">{renderAnswer(result.answer)}</div>

      <div className="section-label">Recalled memories ({result.citations.length})</div>
      {result.citations.map((cit) => (
        <div className="mem" key={cit.marker + cit.sourceRef}>
          <div className="mem-head">
            <span className="marker">{cit.marker}</span>
            <span className="kind-pill">{cit.kind}</span>
            <span className="score">
              cosine <b>{formatScore(cit.score)}</b>
            </span>
          </div>
          <div className="mem-body">{cit.content}</div>
        </div>
      ))}

      <div className="section-label">Self-audit over recalled memories</div>
      {auditFindings.length === 0 ? (
        <p className="empty">No contradictions among the recalled memories.</p>
      ) : (
        auditFindings.map((c, i) => <ContradictionCard c={c} key={i} />)
      )}
    </section>
  );
}
