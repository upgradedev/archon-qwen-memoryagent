import { useEffect, useState } from "react";
import type { Health, MemoryCount } from "./types";
import { getHealth, getMemoryCount, API_URL } from "./api";
import { DEMO_HEALTH, DEMO_COUNT } from "./demo";
import { StatusBar } from "./components/StatusBar";
import { AskPanel } from "./components/AskPanel";
import { AuditPanel } from "./components/AuditPanel";

export default function App() {
  // Judge-facing builds are live-first. Demo mode remains an explicit offline
  // choice, and a failed live request is visibly labelled by each panel.
  const [live, setLive] = useState(true);
  const [health, setHealth] = useState<Health>(DEMO_HEALTH);
  const [count, setCount] = useState<MemoryCount>(DEMO_COUNT);
  const [statusLive, setStatusLive] = useState(false);

  // Refresh the status bar whenever the Live toggle changes.
  useEffect(() => {
    let cancelled = false;
    if (!live) {
      setHealth(DEMO_HEALTH);
      setCount(DEMO_COUNT);
      setStatusLive(false);
      return;
    }
    (async () => {
      const [h, c] = await Promise.all([getHealth(), getMemoryCount()]);
      if (cancelled) return;
      setHealth(h.data);
      setCount(c.data);
      setStatusLive(h.live && c.live);
    })();
    return () => {
      cancelled = true;
    };
  }, [live]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="title">
            Archon <span className="accent">MemoryAgent</span>
          </h1>
          <p className="subtitle">self-auditing memory — grounded recall over persistent, cross-session memory</p>
        </div>

        <label className="toggle">
          <span>Demo</span>
          <button
            type="button"
            data-on={live}
            aria-pressed={live}
            aria-label="Toggle live API"
            onClick={() => setLive((v) => !v)}
          >
            <span className="knob" />
          </button>
          <span className="live-label" data-on={live}>
            Live
          </span>
        </label>
      </header>

      <StatusBar health={health} count={count} live={statusLive} />

      <div className="grid">
        <AskPanel live={live} onLiveResult={() => undefined} />
        <AuditPanel live={live} onLiveResult={() => undefined} />
      </div>

      <p className="footer">
        {live ? (
          <>
            Live mode — calling <code>{API_URL}</code>. Any fallback is prominently
            labelled as canned demo data.
          </>
        ) : (
          <>
            Demo mode — canned data, zero backend. Flip the toggle to call the live
            API at <code>{API_URL}</code>.
          </>
        )}
      </p>
    </div>
  );
}
