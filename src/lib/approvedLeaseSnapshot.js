const APPROVED_REVIEW_STATUSES = new Set(["accepted", "edited", "approved", "reviewed"]);

export function hasApprovalSnapshot(lease) {
  return Boolean(lease?.abstract_snapshot && typeof lease.abstract_snapshot === "object");
}

function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function valueFromFieldCandidate(candidate) {
  if (candidate == null) return null;
  if (typeof candidate !== "object") return candidate;
  return candidate.value ?? candidate.normalized_value ?? candidate.normalizedValue ?? candidate.raw_value ?? null;
}

function isApprovedSnapshotEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const status = String(entry.review_status ?? entry.status ?? "").trim().toLowerCase();
  return APPROVED_REVIEW_STATUSES.has(status);
}

export function approvedLeaseFieldValue(lease, keys, aliases = {}) {
  const candidates = (Array.isArray(keys) ? keys : [keys]).flatMap((key) => aliases[key] || [key]);
  const snapshot = hasApprovalSnapshot(lease) ? lease.abstract_snapshot : null;
  const approvedFields = snapshot?.approved || {};
  const snapshotFields = snapshot?.fields || {};

  for (const key of candidates) {
    const approvedValue = valueFromFieldCandidate(approvedFields?.[key]);
    if (isPresent(approvedValue)) return approvedValue;
  }

  for (const key of candidates) {
    const snapshotEntry = snapshotFields?.[key];
    if (!isApprovedSnapshotEntry(snapshotEntry)) continue;
    const snapshotValue = valueFromFieldCandidate(snapshotEntry);
    if (isPresent(snapshotValue)) return snapshotValue;
  }

  if (snapshot) return null;

  const extractionFields = lease?.extraction_data?.fields || {};
  const extractedFields = lease?.extracted_fields || {};
  for (const key of candidates) {
    if (isPresent(lease?.[key])) return lease[key];
    const extractedValue = valueFromFieldCandidate(extractedFields?.[key]);
    if (isPresent(extractedValue)) return extractedValue;
    const extractionValue = valueFromFieldCandidate(extractionFields?.[key]);
    if (isPresent(extractionValue)) return extractionValue;
  }

  return null;
}
