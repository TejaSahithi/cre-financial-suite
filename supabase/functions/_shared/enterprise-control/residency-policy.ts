// @ts-nocheck
export function enforceResidency(policy, operation) {
  if (!policy) return { allowed: false, reasonCodes: ["residency_policy_missing"] };
  if (operation.kind === "processing" && !policy.allowedProcessingRegions.includes(operation.region)) return { allowed: false, reasonCodes: ["processing_region_not_allowed"] };
  if (operation.kind === "storage" && !policy.allowedStorageRegions.includes(operation.region)) return { allowed: false, reasonCodes: ["storage_region_not_allowed"] };
  if (operation.kind === "backup" && operation.crossRegion && !policy.crossRegionBackupAllowed) return { allowed: false, reasonCodes: ["cross_region_backup_denied"] };
  if (operation.kind === "failover" && operation.crossRegion && !policy.crossRegionFailoverAllowed) return { allowed: false, reasonCodes: ["cross_region_failover_denied"] };
  return { allowed: true, reasonCodes: ["residency_allowed"] };
}