// @ts-nocheck
export function verifyBackupRun(run, now = new Date()) {
  const failures = [];
  if (!run.backupIdentifier) failures.push("backup_identifier_missing");
  if (run.maxAgeHours && now.getTime() - Date.parse(run.completedAt) > run.maxAgeHours * 3600000) failures.push("backup_too_old");
  if (!run.encrypted) failures.push("backup_not_encrypted");
  if (run.integrity !== "passed") failures.push("integrity_not_passed");
  if (run.restoreTest !== "passed") failures.push("restore_test_not_passed");
  return { result: failures.length ? "failed" : "passed", failures, reasonCodes: failures.length ? failures : ["backup_verified"] };
}