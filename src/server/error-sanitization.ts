export interface SanitizedOperationalFailure {
  failureCategory: string;
  errorName: string;
}

/**
 * Project an arbitrary failure onto fixed, non-sensitive operator metadata.
 * Exception messages/stacks can contain URLs, SQL, file paths, payloads, or
 * credentials. Even Error.name is accepted only when it is a plain class token.
 */
export function sanitizedOperationalFailure(
  failureCategory: string,
  error: unknown,
): SanitizedOperationalFailure {
  const candidate = error instanceof Error ? error.name : "";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(candidate)
    ? candidate
    : "UnknownError";
  return {
    failureCategory: /^[a-z][a-z0-9_]{0,63}$/.test(failureCategory)
      ? failureCategory
      : "operational_error",
    errorName,
  };
}
