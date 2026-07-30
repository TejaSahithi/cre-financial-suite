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

function expandApprovedFieldAliases(keys, aliases = {}) {
  const input = Array.isArray(keys) ? keys : [keys];
  const expanded = [];
  for (const key of input) {
    expanded.push(key);
    if (Array.isArray(aliases[key])) expanded.push(...aliases[key]);
  }
  return [...new Set(expanded.filter(Boolean))];
}

export function approvedLeaseFieldValue(lease, keys, aliases = {}) {
  const candidates = expandApprovedFieldAliases(keys, aliases);
  const snapshot = hasApprovalSnapshot(lease) ? lease.abstract_snapshot : null;
  const approvedFields = snapshot?.approved || {};
  const snapshotFields = snapshot?.fields || {};
  const fieldReviews = lease?.extraction_data?.field_reviews || snapshot?.field_reviews || {};

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

  for (const key of candidates) {
    const reviewEntry = fieldReviews?.[key];
    if (!isApprovedSnapshotEntry(reviewEntry)) continue;
    const reviewValue = valueFromFieldCandidate(reviewEntry);
    if (isPresent(reviewValue)) return reviewValue;
  }

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
