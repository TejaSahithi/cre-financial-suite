// @ts-nocheck
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildAbstractSnapshot,
  buildCriticalDateRows,
  validateApprovalPayload,
} from "../_shared/lease-approval-workflow.ts";

Deno.test("validateApprovalPayload requires core approval fields", () => {
  assertThrows(
    () => validateApprovalPayload({}),
    Error,
    "lease_id is required",
  );
  assertThrows(
    () => validateApprovalPayload({
      lease_id: "lease-1",
      signed_by: "Pat",
      signed_at: "bad-date",
      idempotency_key: "key-1",
    }),
    Error,
    "signed_at must be a valid date/time",
  );
});

Deno.test("validateApprovalPayload normalizes valid approval input", () => {
  const result = validateApprovalPayload({
    lease_id: "lease-1",
    signed_by: "Pat Reviewer",
    signed_at: "2026-06-02T10:00:00-04:00",
    approval_comments: "Approved",
    field_reviews: { tenant_name: { status: "accepted", value: "Tenant LLC" } },
    idempotency_key: "key-1",
  });

  assertEquals(result.leaseId, "lease-1");
  assertEquals(result.signedBy, "Pat Reviewer");
  assertEquals(result.signedAt, "2026-06-02T14:00:00.000Z");
  assertEquals(Object.keys(result.fieldReviews), ["tenant_name"]);
});

Deno.test("buildAbstractSnapshot groups approved and rejected field reviews", () => {
  const snapshot = buildAbstractSnapshot({
    lease: {
      extracted_fields: {
        tenant_name: { value: "Original Tenant" },
        monthly_rent: { value: "1000" },
      },
    },
    fieldReviews: {
      tenant_name: { status: "accepted", value: "Tenant LLC", reviewer: "Pat" },
      monthly_rent: { status: "rejected", value: "1000" },
    },
    version: 3,
    approvedBy: "Pat",
    approvedAt: "2026-06-02T14:00:00.000Z",
  });

  assertEquals(snapshot.version, 3);
  assertEquals(snapshot.approved_by, "Pat");
  assertEquals(snapshot.fields.tenant_name.value, "Tenant LLC");
  assertEquals(snapshot.approved.tenant_name.review_status, "accepted");
  assertEquals(snapshot.rejected_fields.monthly_rent.review_status, "rejected");
});

Deno.test("buildCriticalDateRows derives idempotent lease milestone rows", () => {
  const rows = buildCriticalDateRows({
    id: "lease-1",
    org_id: "org-1",
    property_id: "property-1",
    commencement_date: "06/01/2026",
    rent_commencement_date: "2026-07-01",
    expiration_date: "2027-06-30",
    renewal_notice_days: 90,
  }, "2026-06-02");

  assertEquals(rows.map((row) => row.date_type), [
    "commencement",
    "rent_commencement",
    "expiration",
    "renewal_notice",
  ]);
  assertEquals(rows.find((row) => row.date_type === "renewal_notice")?.due_date, "2027-04-01");
  assertEquals(rows.every((row) => row.source === "derived"), true);
});
