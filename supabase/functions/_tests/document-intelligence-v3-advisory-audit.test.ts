// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildAdvisoryAudit,
  buildBatchAdvisoryAuditSummary,
  buildCurrentReviewSnapshot,
} from "../_shared/extraction/document-intelligence-v3/advisory-audit.ts";

function advisory(overrides = {}) {
  return {
    diagnostic_only: true,
    advisory_status: "advisory_ready",
    advisory_reason: "ready",
    would_block_approval: false,
    would_allow_approval: true,
    profile_key: "full_lease",
    policy_key: "base_lease",
    run_id: "run-1",
    uploaded_file_id: "uf-1",
    lease_id: "lease-1",
    blockers: [],
    evidence_issues: [],
    related_document_issues: [],
    ...overrides,
  };
}

function current(overrides = {}) {
  return buildCurrentReviewSnapshot({
    explicitSnapshot: {
      current_status: "allows_approval",
      current_allows_approval: true,
      current_blocks_approval: false,
      current_approval_blockers: [],
      missing_required: [],
      counts: { total: 1, resolved: 1, missing: 0, needs_review: 0 },
      ...overrides,
    },
  });
}

Deno.test("advisory audit: v3 blocked plus current allows approval produces stricter-v3 discrepancy", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory({ advisory_status: "advisory_blocked", would_block_approval: true, would_allow_approval: false }),
    currentReviewSnapshot: current(),
    generatedAt: "2026-07-14T00:00:00.000Z",
    auditId: "audit-1",
  });
  assertEquals(audit.comparison.agreement_level, "differs_v3_stricter");
  assert(audit.discrepancies.some((d) => d.type === "current_path_may_be_too_permissive"));
});

Deno.test("advisory audit: v3 ready plus current blocks produces stricter-current discrepancy", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory(),
    currentReviewSnapshot: current({
      current_status: "blocks_approval",
      current_allows_approval: false,
      current_blocks_approval: true,
      current_approval_blockers: [{ field_key: "tenant_name" }],
    }),
  });
  assertEquals(audit.comparison.agreement_level, "differs_v3_more_permissive");
  assert(audit.discrepancies.some((d) => d.type === "current_path_may_be_too_strict"));
});

Deno.test("advisory audit: unknown profile does not inherit base lease blockers", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory({
      advisory_status: "advisory_needs_review",
      policy_key: "unknown_cre_document",
      blockers: [{ blocker_type: "profile_unknown", severity: "needs_review" }],
    }),
    currentReviewSnapshot: current({
      current_status: "blocks_approval",
      current_allows_approval: false,
      current_blocks_approval: true,
      current_approval_blockers: [{ field_key: "monthly_rent" }],
    }),
  });
  assert(audit.discrepancies.some((d) => d.type === "profile_policy_mismatch"));
  assert(!audit.v3_advisory.blockers.some((b) => b.field_key === "monthly_rent"));
});

Deno.test("advisory audit: assignment false full-lease blocker is detected", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory({ profile_key: "assignment", policy_key: "assignment_assumption" }),
    currentReviewSnapshot: current({
      current_status: "blocks_approval",
      current_allows_approval: false,
      current_blocks_approval: true,
      missing_required: ["monthly_rent", "lease_type"],
    }),
  });
  assertEquals(audit.comparison.agreement_level, "differs_v3_more_permissive");
  assert(audit.discrepancies.some((d) => d.type === "assignment_false_full_lease_blocker"));
});

Deno.test("advisory audit: missing evidence mismatch is detected", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory({
      advisory_status: "advisory_blocked",
      would_block_approval: true,
      would_allow_approval: false,
      evidence_issues: [{ blocker_type: "missing_source_evidence", field_key: "tenant_name" }],
    }),
    currentReviewSnapshot: current(),
  });
  assert(audit.discrepancies.some((d) => d.type === "evidence_requirement_mismatch"));
});

Deno.test("advisory audit: missing related document mismatch is detected", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: advisory({
      advisory_status: "advisory_needs_review",
      would_allow_approval: false,
      related_document_issues: [{ reason: "missing_related_document:original_lease" }],
    }),
    currentReviewSnapshot: current({
      current_status: "blocks_approval",
      current_allows_approval: false,
      current_blocks_approval: true,
      missing_required: ["monthly_rent"],
    }),
  });
  assert(audit.discrepancies.some((d) => d.type === "related_document_policy_mismatch"));
});

Deno.test("advisory audit: no v3 run returns insufficient_data / not_comparable", () => {
  const audit = buildAdvisoryAudit({
    v3Advisory: null,
    currentReviewSnapshot: current(),
  });
  assertEquals(audit.audit_status, "insufficient_data");
  assert(["insufficient_data", "not_comparable"].includes(audit.comparison.agreement_level));
  assert(audit.comparison.missing_inputs.includes("v3_approval_advisory"));
});

Deno.test("advisory audit: current snapshot is read-only and infers counts from ui_review_payload", () => {
  const snapshot = buildCurrentReviewSnapshot({
    uploadedFile: {
      id: "uf-1",
      status: "review_required",
      processing_status: "review_required",
      review_status: "pending",
      ui_review_payload: {
        records: [{ standard_fields: { tenant_name: { value: "Tenant", status: "accepted", accepted: true } } }],
      },
    },
    lease: { id: "lease-1", source_file_id: "uf-1", extraction_data: {} },
  });
  assertEquals(snapshot.uploaded_file_status, "review_required");
  assertEquals(snapshot.counts.accepted, 1);
  assertEquals(snapshot.current_allows_approval, true);
});

Deno.test("advisory audit endpoint: source is org-scoped and does not mutate approval state", () => {
  const source = Deno.readTextFileSync("supabase/functions/document-intelligence-v3-advisory-audit/index.ts");
  assert(source.includes("verifyUser(req)"));
  assert(source.includes("getUserOrgId(user.id, supabaseAdmin, req)"));
  assert(source.includes(".eq(\"org_id\", orgId)"));
  assert(!source.includes(".rpc(\"approve_lease_workflow\""));
  assert(!source.includes("functions/v1/review-approve"));
  assert(!source.includes(".update({"));
  assert(!source.includes(".delete("));
});

Deno.test("advisory audit endpoint: persist_snapshot is explicitly deferred and does not write approval state", () => {
  const source = Deno.readTextFileSync("supabase/functions/document-intelligence-v3-advisory-audit/index.ts");
  assert(source.includes("persist_snapshot"));
  assert(source.includes("durable storage deferred"));
  assert(!source.includes(".from(\"document_intelligence_advisory_audits\")"));
  assert(!source.includes(".insert("));
});

Deno.test("advisory audit phase guard: approve_lease_workflow behavior is unchanged", () => {
  const source = Deno.readTextFileSync("supabase/functions/approve-lease-workflow/index.ts");
  assert(source.includes("supabaseAdmin.rpc(\"approve_lease_workflow\""));
  assert(!source.includes("document-intelligence-v3-advisory-audit"));
  assert(!source.includes("advisory_audit"));
});

Deno.test("advisory audit phase guard: Lease Review business rows are unchanged", () => {
  const source = Deno.readTextFileSync("src/pages/LeaseReview.jsx");
  assert(source.includes("const canApprove = approvalBlockers.length === 0;"));
  assert(source.includes("approveLeaseWorkflow({"));
  assert(!source.includes("document-intelligence-v3-advisory-audit"));
  assert(!source.includes("advisory_audit"));
  assert(!source.includes("V3 Advisory Audit / Current Review Comparison"));
});

Deno.test("advisory audit: batch helper summarizes agreements and discrepancies", () => {
  const audits = [
    buildAdvisoryAudit({ v3Advisory: advisory(), currentReviewSnapshot: current() }),
    buildAdvisoryAudit({
      v3Advisory: advisory({ advisory_status: "advisory_blocked", would_block_approval: true, would_allow_approval: false }),
      currentReviewSnapshot: current(),
    }),
  ];
  const batch = buildBatchAdvisoryAuditSummary(audits);
  assertEquals(batch.total, 2);
  assertEquals(batch.agreement_counts.agrees, 1);
  assertEquals(batch.discrepancy_counts.current_path_may_be_too_permissive, 1);
});
