export interface K6SummaryMetric {
  type?: string;
  contains?: string;
  values?: Record<string, unknown>;
  thresholds?: Record<string, { ok?: boolean }>;
}

export function deterministicTextSummary(data: {
  metrics?: Record<string, K6SummaryMetric>;
}): string;
