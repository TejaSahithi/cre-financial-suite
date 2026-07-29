// @ts-nocheck

export function isLeaseModuleType(moduleType: string | null | undefined): boolean {
  return moduleType === "lease" || moduleType === "leases";
}

