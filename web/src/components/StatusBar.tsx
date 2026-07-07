import type { Health, MemoryCount } from "../types";

interface Props {
  health: Health;
  count: MemoryCount;
  live: boolean; // whether the shown values came from the live API
}

// Status bar: live model ids + embedding dimension (GET /health) and the current
// memory size (GET /memory/count). The dot is cyan on live data, orange on demo.
export function StatusBar({ health, count, live }: Props) {
  return (
    <div className="statusbar">
      <span className="status-item">
        <span className="dot" data-live={live} />
        <b>{health.status === "ok" ? "online" : health.status}</b>
      </span>
      <span className="status-item">
        embedder&nbsp;<b>{health.embedder}</b>
      </span>
      <span className="status-item">
        narrator&nbsp;<b>{health.narrator}</b>
      </span>
      <span className="status-item">
        dim&nbsp;<b>{health.embedDim}</b>
      </span>
      <span className="status-spacer" />
      <span className="status-item">
        memories&nbsp;<b>{count.count.toLocaleString("en-US")}</b>
      </span>
    </div>
  );
}
