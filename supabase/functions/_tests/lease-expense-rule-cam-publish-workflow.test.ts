import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  deriveServerCamPublishBlockers,
  validateCamPublishPayload,
} from "../_shared/lease-expense-rule-cam-publish-workflow.ts";

Deno.test("validateCamPublishPayload requires rule_id and idempotency_key", () => {
  assertThrows(
    () => validateCamPublishPayload({}),
    Error,
    "rule_id is required",
  );
  assertThrows(
    () => validateCamPublishPayload({ rule_id: "11111111-1111-4111-8111-111111111111" }),
    Error,
    "idempotency_key is required",
  );
});

Deno.test("deriveServerCamPublishBlockers allows approved recoverable CAM rule", () => {
  const blockers = deriveServerCamPublishBlockers({
    approval_status: "approved",
    review_status: "approved",
    recoverable_from_tenant: "yes",
    cam_eligible: "yes",
    payment_treatment: "reimbursable",
    exact_source_text: "Tenant shall pay common area maintenance expenses.",
  });

  assertEquals(blockers, []);
});

Deno.test("deriveServerCamPublishBlockers handles already published rule", () => {
  assertEquals(deriveServerCamPublishBlockers({ published_to_cam: true }), ["already_published"]);
});

Deno.test("deriveServerCamPublishBlockers blocks missing mapping or blocking reasons", () => {
  const blockers = deriveServerCamPublishBlockers({
    approval_status: "draft",
    review_status: "needs_review",
    recoverable_from_tenant: "no",
    cam_eligible: "no",
    payment_treatment: "tenant_direct_contract",
    row_status: "unmapped",
  });

  assertEquals(blockers.includes("not_approved"), true);
  assertEquals(blockers.includes("not_recoverable"), true);
  assertEquals(blockers.includes("not_cam_eligible"), true);
  assertEquals(blockers.includes("tenant_direct"), true);
  assertEquals(blockers.includes("explicit_exclusion"), true);
  assertEquals(blockers.includes("missing_lease_evidence"), true);
});
