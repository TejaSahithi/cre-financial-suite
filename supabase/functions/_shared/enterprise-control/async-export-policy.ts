// @ts-nocheck
export function asyncExportDecision(request, policy) {
  const failures = [];
  if (request.rowCount > policy.maxRows) failures.push("export_row_limit_exceeded");
  if (request.estimatedBytes > policy.maxBytes) failures.push("export_size_limit_exceeded");
  if (!request.encryptionRequested) failures.push("export_encryption_required");
  if (!request.expiresAt) failures.push("export_expiration_required");
  return { accepted: failures.length === 0, mode: "async", reasonCodes: failures.length ? failures : ["async_export_accepted"] };
}