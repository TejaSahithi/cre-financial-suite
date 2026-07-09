// Feature: enterprise-readiness-hardening Phase HARD-3Y (compute-orchestrator
// internal auth hotfix). Proves buildComputeCallHeaders() -- the header
// builder callOnce() now delegates to -- includes a real
// Authorization: Bearer <service-role-key> header (satisfying Kong's
// verify_jwt=true gate on every compute-* target: compute-lease,
// compute-cam, compute-budget, compute-revenue, compute-expense), while
// preserving every pre-existing internal/correlation header exactly as
// before. Same fix shape/rationale as HARD-3X
// (_shared/lease-approval-workflow.ts::generateApprovedRentSchedule),
// verified via a live HTTP round-trip in
// lease-approval-rent-schedule-atomicity.property.test.ts; this test is a
// pure unit test of the header-construction function (no network, no live
// Supabase instance required) since callOnce() itself is not exported and
// its retry/HTTP behavior is unchanged by this fix.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildComputeCallHeaders } from "../_shared/compute-orchestrator.ts";

const FAKE_SERVICE_KEY = "fake-service-role-key-for-unit-test-only";

Deno.test({
  name: "buildComputeCallHeaders: includes Authorization Bearer service key, preserves all pre-existing internal headers",
  fn: () => {
    const headers = buildComputeCallHeaders(FAKE_SERVICE_KEY, "org-1", "file-1") as Record<string, string>;

    assertEquals(headers["Authorization"], `Bearer ${FAKE_SERVICE_KEY}`);
    assertEquals(headers["apikey"], FAKE_SERVICE_KEY);
    assertEquals(headers["x-internal-service-key"], FAKE_SERVICE_KEY);
    assertEquals(headers["x-internal-org-id"], "org-1");
    assertEquals(headers["x-source-file-id"], "file-1");
    assertEquals(headers["x-compute-trigger"], "upload");
    assertEquals(headers["Content-Type"], "application/json");

    // Exactly 7 keys -- no accidental extra/dropped header.
    assertEquals(Object.keys(headers).length, 7);
  },
});

Deno.test({
  name: "buildComputeCallHeaders: different orgId/fileId values are reflected independently, key value unaffected",
  fn: () => {
    const headers = buildComputeCallHeaders(FAKE_SERVICE_KEY, "org-2", "file-2") as Record<string, string>;
    assertEquals(headers["x-internal-org-id"], "org-2");
    assertEquals(headers["x-source-file-id"], "file-2");
    assertEquals(headers["Authorization"], `Bearer ${FAKE_SERVICE_KEY}`);
  },
});

Deno.test({
  name: "buildComputeCallHeaders: does not throw, key appears exactly the expected number of times (apikey + x-internal-service-key + inside Authorization) -- no unexpected extra copies/logging",
  fn: () => {
    const headers = buildComputeCallHeaders(FAKE_SERVICE_KEY, "org-3", "file-3");
    const serialized = JSON.stringify(headers);
    const occurrences = serialized.split(FAKE_SERVICE_KEY).length - 1;
    // The key appears exactly 3 times: apikey, x-internal-service-key, and
    // inside the Authorization "Bearer <key>" value -- never duplicated or
    // logged elsewhere by this function.
    assertEquals(occurrences, 3);
    assertExists(serialized);
  },
});
