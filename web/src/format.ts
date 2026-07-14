// Small formatting helpers shared across panels.

// Format an unknown audit attribute without inventing a currency. The
// contradiction contract carries arbitrary values (counts, limits, quantities,
// money) and no currency field, so a hard-coded symbol would be misleading.
export function formatValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString("en-US", { maximumFractionDigits: 6 })
      : "—";
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
