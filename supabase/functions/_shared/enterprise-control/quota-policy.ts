// @ts-nocheck
export function quotaState(quota, counter) {
  const value = Number(counter?.currentValue || 0);
  if (!quota) return { state: "healthy", operationAllowed: true, reasonCodes: ["quota_not_configured"] };
  if (value >= quota.hardLimit) return { state: "hard_limit", operationAllowed: false, reasonCodes: ["hard_quota_exceeded"] };
  if (value >= quota.softLimit) return { state: "soft_limit", operationAllowed: true, reasonCodes: ["soft_quota_exceeded"] };
  if (value >= quota.softLimit * 0.8) return { state: "warning", operationAllowed: true, reasonCodes: ["quota_warning"] };
  return { state: "healthy", operationAllowed: true, reasonCodes: ["quota_healthy"] };
}