// @ts-nocheck
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildAbstractSnapshot,
  buildCriticalDateRows,
  materializeApprovedLeaseObligations,
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
        commencement_date: { value: "2026-01-01" },
        expiration_date: { value: "2026-12-31" },
        annual_rent: { value: "12000" },
        monthly_rent: { value: "1000" },
      },
    },
    fieldReviews: {
      tenant_name: { status: "accepted", value: "Tenant LLC", reviewer: "Pat" },
      commencement_date: { status: "accepted", value: "2026-01-01" },
      expiration_date: { status: "accepted", value: "2026-12-31" },
      annual_rent: { status: "accepted", value: "12000" },
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

Deno.test("buildAbstractSnapshot preserves source document identity", () => {
  const snapshot = buildAbstractSnapshot({
    lease: {
      source_file_id: "upload-a",
      extraction_data: {
        source_file_id: "legacy-upload-a",
        source_file_name: "phase5d-source.pdf",
        document_subtype: "base_lease",
        fields: {
          tenant_name: { value: "Tenant LLC" },
          commencement_date: { value: "2026-01-01" },
          expiration_date: { value: "2026-12-31" },
          monthly_rent: { value: 1000 },
        },
      },
    },
    fieldReviews: {
      tenant_name: { status: "accepted", value: "Tenant LLC" },
      commencement_date: { status: "accepted", value: "2026-01-01" },
      expiration_date: { status: "accepted", value: "2026-12-31" },
      monthly_rent: { status: "accepted", value: 1000 },
    },
    version: 1,
    approvedBy: "Pat",
    approvedAt: "2026-07-17T12:00:00.000Z",
  });

  assertEquals(snapshot.uploaded_file_id, "upload-a");
  assertEquals(snapshot.source_document, {
    uploaded_file_id: "upload-a",
    source_file_id: "upload-a",
    source_file_name: "phase5d-source.pdf",
    document_subtype: "base_lease",
  });
});

Deno.test("buildAbstractSnapshot canonicalizes a next-anniversary date to the final term year", () => {
  const snapshot = buildAbstractSnapshot({
    lease: {
      extracted_fields: {
        commencement_date: { value: "2024-02-01" },
        expiration_date: { value: "2025-01-31" },
        end_date: { value: "2025-01-31" },
        lease_term_months: { value: 60 },
        monthly_rent: { value: 1000 },
      },
    },
    fieldReviews: {
      commencement_date: { status: "accepted", value: "2024-02-01" },
      expiration_date: { status: "accepted", value: "2025-01-31" },
      end_date: { status: "accepted", value: "2025-01-31" },
      lease_term_months: { status: "accepted", value: 60 },
      monthly_rent: { status: "accepted", value: 1000 },
    },
    version: 1,
    approvedBy: "Pat",
  });

  assertEquals(snapshot.approved.expiration_date.value, "2029-01-31");
  assertEquals(snapshot.approved.end_date.value, "2029-01-31");
  assertEquals(snapshot.approved.expiration_date.extraction_status, "calculated");
});

Deno.test("buildAbstractSnapshot blocks conflicting approved monthly and annual rent", () => {
  assertThrows(
    () => buildAbstractSnapshot({
      lease: {
        extracted_fields: {
          monthly_rent: { value: 2000 },
          annual_rent: { value: 12000 },
        },
      },
      fieldReviews: {
        monthly_rent: { status: "accepted", value: 2000 },
        annual_rent: { status: "accepted", value: 12000 },
      },
      version: 1,
      approvedBy: "Pat",
    }),
    Error,
    "Approved monthly and annual rent conflict",
  );
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

Deno.test("buildCriticalDateRows publishes only approved snapshot fields for current approvals", () => {
  const rows = buildCriticalDateRows({
    id: "lease-1",
    org_id: "org-1",
    property_id: "property-1",
    commencement_date: "1900-01-01",
    expiration_date: "1900-12-31",
    abstract_snapshot: {
      approved: {
        commencement_date: { value: "2026-06-01", review_status: "accepted" },
      },
      fields: {
        expiration_date: { value: "2027-05-31", review_status: "pending" },
        rent_commencement_date: { value: "2026-07-01", review_status: "pending" },
      },
    },
  }, "2026-06-02");

  assertEquals(rows.map((row) => row.date_type), ["commencement"]);
  assertEquals(rows[0]?.due_date, "2026-06-01");
});

Deno.test("buildCriticalDateRows uses the final term year instead of the next annual anniversary", () => {
  const rows = buildCriticalDateRows({
    id: "lease-final-term-year",
    org_id: "org-1",
    abstract_snapshot: {
      approved: {
        commencement_date: { value: "2024-02-01", review_status: "accepted" },
        expiration_date: { value: "2025-01-31", review_status: "accepted" },
        lease_term_months: { value: 60, review_status: "accepted" },
      },
    },
  }, "2024-02-01");

  assertEquals(
    rows.find((row) => row.date_type === "expiration")?.due_date,
    "2029-01-31",
  );
});

Deno.test("buildCriticalDateRows does not treat rent commencement or lease date as commencement", () => {
  const rows = buildCriticalDateRows({
    id: "lease-1",
    org_id: "org-1",
    property_id: "property-1",
    abstract_snapshot: {
      approved: {
        lease_date: { value: "2026-05-15", review_status: "accepted" },
        rent_commencement_date: { value: "2026-07-01", review_status: "accepted" },
      },
    },
  }, "2026-06-02");

  assertEquals(rows.map((row) => row.date_type), ["lease_date", "rent_commencement"]);
});

Deno.test("materializeApprovedLeaseObligations creates idempotent operational obligations", async () => {
  let capturedTable = "";
  let capturedRows: Record<string, unknown>[] = [];
  let capturedConflict = "";
  const supabaseAdmin = {
    from(table: string) {
      capturedTable = table;
      return {
        upsert(rows: Record<string, unknown>[], options: Record<string, unknown>) {
          capturedRows = rows;
          capturedConflict = String(options?.onConflict || "");
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  const result = await materializeApprovedLeaseObligations({
    supabaseAdmin,
    orgId: "org-1",
    lease: { id: "lease-1", property_id: "property-1", abstract_version: 2 },
    criticalDates: [{
      org_id: "org-1",
      lease_id: "lease-1",
      property_id: "property-1",
      date_type: "renewal_notice",
      due_date: "2027-04-01",
      status: "open",
      source: "derived",
    }],
  });

  assertEquals(result, { status: "ok", obligations_persisted: 1 });
  assertEquals(capturedTable, "lease_obligations");
  assertEquals(capturedConflict, "org_id,lease_id,source_key");
  assertEquals(capturedRows[0].source_key, "approved_critical_date:renewal_notice:2027-04-01");
  assertEquals(capturedRows[0].cadence, "once");
  assertEquals(capturedRows[0].due_rule, { due_date: "2027-04-01" });
});
