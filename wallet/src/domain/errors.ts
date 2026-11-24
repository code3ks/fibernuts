const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/cashu[AB][A-Za-z0-9_-]+/gi, "[redacted Cashu token]"],
  [/creq[ab][A-Za-z0-9_-]+/gi, "[redacted payment request]"],
  [/fib(?:t|d|m)1[0-9a-z]+/gi, "[redacted Fiber invoice]"],
  [/(Bearer\s+)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]"],
  [/("?(?:secret|privateKey|quotePrivateKey)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]"],
];

export function safeErrorMessage(reason: unknown, fallback = "The operation could not be completed."): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  let safe = raw || fallback;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe.length > 500 ? `${safe.slice(0, 497)}...` : safe;
}
