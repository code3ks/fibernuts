const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/cashu[AB][A-Za-z0-9_-]+/gi, "[redacted Cashu token]"],
  [/creq[ab][A-Za-z0-9_-]+/gi, "[redacted payment request]"],
  [/fibt1[0-9a-z]+/gi, "[redacted Fiber invoice]"],
  [/(Bearer\s+)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]"],
  [/(\/v1\/deliver\/)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]"],
  [/("?(?:secret|privateKey|readCapability|writeCapability)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]"],
  [/\b[a-f0-9]{64}\b/gi, "[redacted 32-byte value]"],
];

export function safeErrorMessage(reason: unknown, fallback = "The operation could not be completed."): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  let safe = raw || fallback;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) safe = safe.replace(pattern, replacement);
  if (safe.length > 500) safe = `${safe.slice(0, 497)}...`;
  return safe;
}
