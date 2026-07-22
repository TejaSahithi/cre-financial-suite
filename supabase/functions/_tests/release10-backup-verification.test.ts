import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyBackupRun } from "../_shared/enterprise-control/backup-verification.ts";

Deno.test("Release 10 backup verification requires restore and integrity checks", () => {
  const result = verifyBackupRun({ backupIdentifier: "b1", completedAt: "2026-07-22T00:00:00.000Z", maxAgeHours: 24, encrypted: true, integrity: "passed", restoreTest: "failed" }, new Date("2026-07-22T01:00:00.000Z"));
  assertEquals(result.result, "failed");
  assertEquals(result.failures, ["restore_test_not_passed"]);
});