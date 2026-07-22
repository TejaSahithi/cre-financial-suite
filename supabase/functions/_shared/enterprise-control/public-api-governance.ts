// @ts-nocheck
export function publicApiScopeDecision(client, requestedScope) {
  if (!client?.active) return { allowed: false, reasonCodes: ["api_client_inactive"] };
  if (!client.scopes?.includes(requestedScope)) return { allowed: false, reasonCodes: ["api_scope_missing"] };
  if (client.rateLimit?.remaining <= 0) return { allowed: false, reasonCodes: ["api_rate_limit_exceeded"] };
  return { allowed: true, reasonCodes: ["api_scope_allowed"] };
}