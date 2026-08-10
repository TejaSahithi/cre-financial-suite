const CAM_INACTIVE_LEASE_STATUSES = new Set([
  "archived",
  "cancelled",
  "canceled",
  "deleted",
  "inactive",
  "rejected",
  "superseded",
  "terminated",
  "void",
  "voided",
]);

const CAM_INACTIVE_ABSTRACT_STATUSES = new Set([
  "archived",
  "deleted",
  "rejected",
  "superseded",
  "void",
  "voided",
]);

export function isLeaseDeletedOrInactiveForCam(lease) {
  if (!lease) return true;
  if (lease.is_deleted === true || lease.deleted === true) return true;
  if (lease.deleted_at || lease.archived_at) return true;

  const status = String(lease.status || "").trim().toLowerCase();
  if (status && CAM_INACTIVE_LEASE_STATUSES.has(status)) return true;

  const abstractStatus = String(lease.abstract_status || "").trim().toLowerCase();
  if (abstractStatus && CAM_INACTIVE_ABSTRACT_STATUSES.has(abstractStatus)) return true;

  return false;
}

export function isCamActiveLease(lease) {
  return !isLeaseDeletedOrInactiveForCam(lease);
}

export function filterCamActiveLeases(leases = []) {
  return (leases || []).filter(isCamActiveLease);
}

export function buildCamActiveLeaseIdSet(leases = []) {
  return new Set(filterCamActiveLeases(leases).map((lease) => lease.id).filter(Boolean));
}

export function filterRowsToCamActiveLeases(rows = [], activeLeaseIds = new Set()) {
  return (rows || []).filter((row) => row?.lease_id && activeLeaseIds.has(row.lease_id));
}
