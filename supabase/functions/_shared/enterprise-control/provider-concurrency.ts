// @ts-nocheck
export function providerConcurrencyDecision(policy, observed) {
  return observed.activeRequests >= policy.maxProviderRequests
    ? { allowed: false, reasonCodes: ["provider_concurrency_exceeded"] }
    : { allowed: true, reasonCodes: ["provider_concurrency_available"] };
}