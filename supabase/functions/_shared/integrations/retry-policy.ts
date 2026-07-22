// @ts-nocheck

export function shouldRetryDelivery(args: { status?: number | null; errorCode?: string | null }) {
  const status = Number(args.status ?? 0);
  if ([400, 401, 403, 404, 422].includes(status)) return { retryable: false, reasonCode: "non_retryable_client_error" };
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return { retryable: true, reasonCode: "retryable_http_error" };
  if (["timeout", "rate_limit", "temporary_auth"].includes(String(args.errorCode ?? ""))) return { retryable: true, reasonCode: `retryable_${args.errorCode}` };
  if (["validation", "permission", "malformed_payload"].includes(String(args.errorCode ?? ""))) return { retryable: false, reasonCode: `non_retryable_${args.errorCode}` };
  return { retryable: false, reasonCode: "unknown_non_retryable" };
}

export function nextRetryDelaySeconds(attemptNumber: number, policy: any = {}) {
  const base = Number(policy.baseDelaySeconds ?? 30);
  const max = Number(policy.maxDelaySeconds ?? 3600);
  return Math.min(max, base * Math.pow(2, Math.max(0, attemptNumber - 1)));
}

export function classifyDeliveryAttempt(args: { attemptNumber: number; status?: number | null; errorCode?: string | null; policy?: any }) {
  if (args.status && args.status >= 200 && args.status < 300) return { retryable: false, nextDelaySeconds: null, terminalStatus: "delivered", reasonCode: "delivered" };
  const retry = shouldRetryDelivery(args);
  const maxAttempts = Number(args.policy?.maxAttempts ?? 5);
  if (!retry.retryable) return { retryable: false, nextDelaySeconds: null, terminalStatus: "failed", reasonCode: retry.reasonCode };
  if (args.attemptNumber >= maxAttempts) return { retryable: false, nextDelaySeconds: null, terminalStatus: "dead_lettered", reasonCode: "max_attempts_exhausted" };
  return { retryable: true, nextDelaySeconds: nextRetryDelaySeconds(args.attemptNumber, args.policy), terminalStatus: "retry_scheduled", reasonCode: retry.reasonCode };
}
