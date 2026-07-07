// Small formatting helpers shared across panels.

// Format an unknown attribute value for display. Numbers that look like money
// (the domain's totals/gaps) render as €-grouped figures; everything else falls
// back to a safe string form. `value` is typed `unknown` in the API, so we guard.
export function formatValue(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return `€${value.toLocaleString("en-US")}`;
    }
    // Non-integer numerics (e.g. a percentage like 75.6) — show as-is.
    return String(value);
  }
  if (typeof value === "string") return value;
  if (value == null) return "—";
  return JSON.stringify(value);
}

// Cosine similarity as a compact percentage-ish score for the recall list.
export function formatScore(score: number): string {
  return score.toFixed(3);
}

// A short, human date from an ISO timestamp.
export function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

// Confidence as a percentage.
export function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}
