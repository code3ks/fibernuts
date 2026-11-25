const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/cashu[AB][A-Za-z0-9_-]+/gi, "[redacted Cashu token]"],
  [/creq[ab][A-Za-z0-9_-]+/gi, "[redacted payment request]"],
  [/fib(?:t|d|b)1[0-9a-z]+/gi, "[redacted Fiber invoice]"],
  [/(Bearer\s+)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]"],
  [/(\/v1\/deliver\/)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]"],
  [/("?(?:secret|proofSecret|token|privateKey|quotePrivateKey|refundPrivateKey|readCapability|writeCapability|authorization|credential|mnemonic|seed|preimage|paymentHash|payment_hash|quoteId|quote_id|requestId|request_id|orderId|order_id|clientId|client_id|operationId|operation_id)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]"],
  [/\b(?:ckb|ckt)1[0-9a-z]{40,}\b/gi, "[redacted CKB address]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]"],
  [/0x[a-f0-9]{64}\b/gi, "[redacted 32-byte value]"],
  [/\b[a-f0-9]{64}\b/gi, "[redacted 32-byte value]"],
];

export function safeErrorMessage(reason: unknown, fallback = "The operation could not be completed."): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  let safe = raw || fallback;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe.length > 500 ? `${safe.slice(0, 497)}...` : safe;
}
