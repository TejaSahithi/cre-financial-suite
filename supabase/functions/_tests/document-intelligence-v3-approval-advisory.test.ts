// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildApprovalAdvisoryFromReadiness,
  emptyApprovalAdvisory,
} from "../_shared/extraction/document-intelligence-v3/approval-advisory.ts";

function field(overrides = {}) {
  return {
    field_key: "tenant_name",
    required: true,
    status: "source_backed",
    value_present: true,
    source_backed: true,
    importance_level: "critical",
    evidence_sufficiency: "text_only",
    source_claim_ids: ["claim-1"],
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    diagnostic_only: true,
    available: true,
    run_id: "run-1",
    uploaded_file_id: "uf-1",
    lease_id: "lease-1",
    profile: {
      profile_key: "full_lease",
      policy_key: "base_lease",
      confidence: 0.9,
      status: "auto_detected",
    },
    readiness: { status: "ready", reason: null },
    required_fields: [field()],
    optional_fields: [],
    advisories: [],
    planner_warnings: [],
    coverage: {
      processing_coverage: { layout_available: true, page_coverage_percent: 100 },
      evidence_coverage: { claims_total: 1, claims_with_evidence: 1 },
      expected_information_coverage: {
        expected_required_fields: 1,
        required_field_coverage_percent: 100,
      },
      related_document_coverage: { related_documents_missing: [] },
      overall_coverage: { coverage_level: "complete", coverage_warnings: [] },
    },
    important_validation_drops: [],
    important_related_documents_missing: [],
    temporal_supersession: {
      diagnostic_only: true,
      temporal_status: "ordered",
      unresolved_temporal_conflicts: [],
      current_truth_candidates: [],
      warnings: [],
    },
    ...overrides,
  };
}

Deno.test("approval advisory: no v3 run returns advisory_not_available and does not throw", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(null);
  assertEquals(advisory.advisory_status, "advisory_not_available");
  assertEquals(advisory.would_block_approval, false);
  assertEquals(emptyApprovalAdvisory().diagnostic_only, true);
});

Deno.test("approval advisory: non_cre_document is not applicable", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    profile: { profile_key: "insurance_certificate", policy_key: "non_cre_document", status: "not_applicable" },
  }));
  assertEquals(advisory.advisory_status, "advisory_not_applicable");
  assertEquals(advisory.would_block_approval, false);
});

Deno.test("approval advisory: unknown_cre_document needs review and does not apply base lease blockers", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    profile: { profile_key: null, policy_key: "unknown_cre_document", status: "unclassified" },
    required_fields: [],
  }));
  assertEquals(advisory.advisory_status, "advisory_needs_review");
  assert(advisory.blockers.some((b) => b.blocker_type === "profile_unknown"));
  assert(!advisory.blockers.some((b) => b.field_key === "monthly_rent"));
});

Deno.test("approval advisory: base lease missing critical required field blocks if enforced", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    required_fields: [field({ field_key: "tenant_name", status: "missing", value_present: false, source_backed: false, missing_reason: "not_attempted" })],
  }));
  assertEquals(advisory.advisory_status, "advisory_blocked");
  assertEquals(advisory.would_block_approval, true);
  assert(advisory.blockers.some((b) => b.blocker_type === "missing_critical_field" && b.severity === "blocking_if_enforced"));
});

Deno.test("approval advisory: assignment document does not block on CAM/monthly_rent/full budget when policy does not require them", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    profile: { profile_key: "assignment", policy_key: "assignment_assumption", status: "auto_detected" },
    required_fields: [
      field({ field_key: "assignor_name", importance_level: "critical" }),
      field({ field_key: "assignee_name", importance_level: "critical" }),
    ],
    optional_fields: [
      field({ field_key: "monthly_rent", required: false, status: "missing", value_present: false, importance_level: "medium" }),
    ],
  }));
  assertEquals(advisory.advisory_status, "advisory_ready");
  assert(!advisory.blockers.some((b) => ["monthly_rent", "lease_type", "cam_amount"].includes(b.field_key)));
});

Deno.test("approval advisory: missing source evidence on critical field produces evidence issue", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    required_fields: [field({
      field_key: "tenant_name",
      status: "needs_review",
      value_present: true,
      source_backed: false,
      missing_reason: "missing_source_evidence",
      evidence_sufficiency: "none",
    })],
  }));
  assertEquals(advisory.advisory_status, "advisory_blocked");
  assert(advisory.evidence_issues.some((b) => b.blocker_type === "insufficient_evidence"));
});

Deno.test("approval advisory: invalid_markup_value produces validation issue", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    important_validation_drops: [{ field_key: "tenant_name", reason: "invalid_markup_value", importance_level: "critical" }],
  }));
  assertEquals(advisory.advisory_status, "advisory_blocked");
  assert(advisory.validation_issues.some((b) => b.validation_drop_reason === "invalid_markup_value"));
});

Deno.test("approval advisory: missing original lease for assignment is related-document issue, not fake full-lease blocker", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    profile: { profile_key: "assignment", policy_key: "assignment_assumption", status: "auto_detected" },
    required_fields: [field({ field_key: "assignor_name" }), field({ field_key: "assignee_name" })],
    important_related_documents_missing: [{ document_type: "original_lease", importance_level: "high" }],
  }));
  assertEquals(advisory.advisory_status, "advisory_needs_review");
  assert(advisory.related_document_issues.some((b) => b.reason === "missing_related_document:original_lease"));
  assert(!advisory.blockers.some((b) => b.field_key === "monthly_rent"));
});

Deno.test("approval advisory: temporal conflict produces temporal issue", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    temporal_supersession: {
      temporal_status: "conflicts_present",
      unresolved_temporal_conflicts: [{ field_key: "expiration_date", reason: "conflicting_current_truth" }],
      current_truth_candidates: [],
    },
  }));
  assertEquals(advisory.advisory_status, "advisory_needs_review");
  assert(advisory.temporal_issues.some((b) => b.blocker_type === "temporal_conflict"));
});

Deno.test("approval advisory: low/minimal coverage produces needs_review", () => {
  const advisory = buildApprovalAdvisoryFromReadiness(readiness({
    coverage: {
      processing_coverage: { layout_available: false, page_coverage_percent: 0 },
      evidence_coverage: { claims_total: 2, claims_with_evidence: 0 },
      expected_information_coverage: { expected_required_fields: 4, required_field_coverage_percent: 25 },
      related_document_coverage: { related_documents_missing: [] },
      overall_coverage: { coverage_level: "minimal", coverage_warnings: ["layout_unavailable"] },
    },
  }));
  assertEquals(advisory.advisory_status, "advisory_needs_review");
  assert(advisory.coverage_issues.length >= 1);
});

Deno.test("approval advisory endpoint: source stays read-only and org-scoped", () => {
  const source = Deno.readTextFileSync("supabase/functions/document-intelligence-v3-approval-advisory/index.ts");
  assert(source.includes("verifyUser(req)"));
  assert(source.includes("getUserOrgId(user.id, supabaseAdmin, req)"));
  assert(source.includes(".eq(\"org_id\", orgId)"));
  assert(!source.includes(".insert("));
  assert(!source.includes(".update("));
  assert(!source.includes(".delete("));
  assert(!source.includes(".rpc(\"approve_lease_workflow\""));
  assert(!source.includes("fetch(`${supabaseUrl}/functions/v1/review-approve"));
});

Deno.test("approval advisory phase guard: approve_lease_workflow behavior is unchanged", () => {
  const source = Deno.readTextFileSync("supabase/functions/approve-lease-workflow/index.ts");
  assert(source.includes("supabaseAdmin.rpc(\"approve_lease_workflow\""));
  assert(!source.includes("document-intelligence-v3-approval-advisory"));
  assert(!source.includes("approval_advisory"));
  assert(!source.includes("buildApprovalAdvisoryFromReadiness"));
});

Deno.test("approval advisory phase guard: Lease Review business rows are unchanged", () => {
  const source = Deno.readTextFileSync("src/pages/LeaseReview.jsx");
  assert(source.includes("const canApprove = approvalBlockers.length === 0;"));
  assert(source.includes("approveLeaseWorkflow({"));
  assert(!source.includes("approval_advisory"));
  assert(!source.includes("V3 Approval Advisory Simulation"));
  assert(!source.includes("document-intelligence-v3-approval-advisory"));
});
