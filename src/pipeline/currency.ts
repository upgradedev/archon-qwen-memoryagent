/**
 * Cached ISO 4217 currency set supplied by the Node/ICU runtime. Syntax alone
 * is not enough: ECMA-402 intentionally accepts unknown three-letter codes in
 * NumberFormat, while supportedValuesOf returns the runtime's sanctioned list.
 */
const FALLBACK_CODES = [
  "AED", "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR",
  "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SAR", "SEK", "SGD", "THB", "TRY",
  "USD", "VND", "ZAR",
] as const;

const supportedValuesOf = (Intl as typeof Intl & {
  supportedValuesOf?: (key: "currency") => string[];
}).supportedValuesOf;

export const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> = new Set(
  supportedValuesOf ? supportedValuesOf("currency") : FALLBACK_CODES,
);

export function normalizeIso4217Currency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.normalize("NFKC").trim().toUpperCase();
  return SUPPORTED_ISO_CURRENCIES.has(currency) ? currency : null;
}

export function isSupportedIso4217Currency(value: unknown): boolean {
  return normalizeIso4217Currency(value) != null;
}
