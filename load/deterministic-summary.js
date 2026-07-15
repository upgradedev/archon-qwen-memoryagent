// Local, deterministic replacement for the previously remote k6-summary module.
// k6 supplies raw metric values and evaluated threshold results to handleSummary;
// this formatter only renders them, so threshold evaluation and exit semantics
// remain owned by k6 itself.

function formatValue(value) {
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

export function deterministicTextSummary(data) {
  const metrics = Object.entries(data?.metrics || {}).sort(([left], [right]) => left.localeCompare(right));
  let thresholdCount = 0;
  let thresholdFailures = 0;

  const rows = metrics.map(([name, metric]) => {
    const values = Object.entries(metric?.values || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${formatValue(value)}`);
    const thresholds = Object.entries(metric?.thresholds || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([expression, result]) => {
        thresholdCount += 1;
        const passed = result?.ok === true;
        if (!passed) thresholdFailures += 1;
        return `${expression}=${passed ? "PASS" : "FAIL"}`;
      });

    const kind = `${metric?.type || "metric"}/${metric?.contains || "default"}`;
    const valueText = values.length ? values.join(", ") : "no values";
    const thresholdText = thresholds.length ? ` | ${thresholds.join(", ")}` : "";
    return ` - ${name} [${kind}]: ${valueText}${thresholdText}`;
  });

  const thresholdState = thresholdCount === 0 ? "NONE" : thresholdFailures === 0 ? "PASS" : "FAIL";
  return [
    "",
    "MemoryAgent k6 summary (deterministic; raw k6 units)",
    `thresholds: ${thresholdState} (${thresholdCount - thresholdFailures}/${thresholdCount})`,
    ...rows,
    "",
  ].join("\n");
}
