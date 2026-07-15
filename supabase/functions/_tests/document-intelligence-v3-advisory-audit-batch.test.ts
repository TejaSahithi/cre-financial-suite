// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAdvisoryAudit, buildCurrentReviewSnapshot } from "../_shared/extraction/document-intelligence-v3/advisory-audit.ts";
import {
  buildBatchAdvisoryAuditReport,
  normalizeBatchAdvisoryAuditInput,
} from "../_shared/extraction/document-intelligence-v3/advisory-audit-batch.ts";

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
    temporal_issues: [],
    coverage_issues: [],
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

function audit({ advisoryOverrides = {}, currentOverrides = {}, auditId = "audit-1" } = {}) {
  return buildAdvisoryAudit({
    v3Advisory: advisory(advisoryOverrides),
    currentReviewSnapshot: current(currentOverrides),
    generatedAt: "2026-07-15T00:00:00.000Z",
    auditId,
  });
}

Deno.test("batch advisory audit: empty input returns total 0 and no error-shaped report", () => {
  const report = buildBatchAdvisoryAuditReport({ audits: [], input: {} });
  assertEquals(report.diagnostic_only, true);
  assertEquals(report.total, 0);
  assertEquals(report.results, []);
  assertEquals(report.agreement_counts.agrees, 0);
  assertEquals(report.discrepancy_counts.current_path_may_be_too_permissive, 0);
  assertEquals(report.risk_summary.not_enough_data, 0);
});

Deno.test("batch advisory audit: single uploaded_file_id returns one compact result", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit()],
    input: { uploaded_file_ids: ["uf-1"] },
  });
  assertEquals(report.total, 1);
  assertEquals(report.results[0].uploaded_file_id, "uf-1");
  assertEquals(report.results[0].run_id, "run-1");
  assertEquals(report.results[0].lease_id, "lease-1");
  assertEquals(report.results[0].agreement_level, "agrees");
});

Deno.test("batch advisory audit: multiple uploaded_file_ids aggregate agreement counts", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [
      audit({ auditId: "audit-agree" }),
      audit({
        auditId: "audit-strict-v3",
        advisoryOverrides: { advisory_status: "advisory_blocked", would_block_approval: true, would_allow_approval: false, uploaded_file_id: "uf-2", run_id: "run-2", lease_id: "lease-2" },
      }),
      audit({
        auditId: "audit-strict-current",
        advisoryOverrides: { uploaded_file_id: "uf-3", run_id: "run-3", lease_id: "lease-3" },
        currentOverrides: { current_status: "blocks_approval", current_allows_approval: false, current_blocks_approval: true, current_approval_blockers: [{ field_key: "tenant_name" }] },
      }),
    ],
    input: { uploaded_file_ids: ["uf-1", "uf-2", "uf-3"] },
  });
  assertEquals(report.total, 3);
  assertEquals(report.agreement_counts.agrees, 1);
  assertEquals(report.agreement_counts.differs_v3_stricter, 1);
  assertEquals(report.agreement_counts.differs_v3_more_permissive, 1);
});

Deno.test("batch advisory audit: v3 stricter discrepancies are counted", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit({ advisoryOverrides: { advisory_status: "advisory_blocked", would_block_approval: true, would_allow_approval: false } })],
  });
  assertEquals(report.discrepancy_counts.current_path_may_be_too_permissive, 1);
  assertEquals(report.risk_summary.likely_false_positive_current_approval, 1);
});

Deno.test("batch advisory audit: v3 more permissive discrepancies are counted", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit({ currentOverrides: { current_status: "blocks_approval", current_allows_approval: false, current_blocks_approval: true, current_approval_blockers: [{ field_key: "tenant_name" }] } })],
  });
  assertEquals(report.discrepancy_counts.current_path_may_be_too_strict, 1);
  assertEquals(report.risk_summary.likely_false_negative_current_block, 1);
});

Deno.test("batch advisory audit: assignment false full-lease blocker appears in discrepancy counts", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit({
      advisoryOverrides: { profile_key: "assignment", policy_key: "assignment_assumption" },
      currentOverrides: { current_status: "blocks_approval", current_allows_approval: false, current_blocks_approval: true, missing_required: ["monthly_rent"] },
    })],
  });
  assertEquals(report.discrepancy_counts.assignment_false_full_lease_blocker, 1);
});

Deno.test("batch advisory audit: evidence mismatch appears in discrepancy counts", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit({ advisoryOverrides: { advisory_status: "advisory_blocked", would_block_approval: true, would_allow_approval: false, evidence_issues: [{ field_key: "tenant_name" }] } })],
  });
  assertEquals(report.discrepancy_counts.evidence_requirement_mismatch, 1);
});

Deno.test("batch advisory audit: temporal and coverage mismatches are countable", () => {
  const report = buildBatchAdvisoryAuditReport({
    audits: [audit({ advisoryOverrides: { temporal_issues: [{ reason: "blocked_missing_related_document" }], coverage_issues: [{ reason: "coverage_level:minimal" }] } })],
  });
  assertEquals(report.discrepancy_counts.temporal_policy_mismatch, 1);
  assertEquals(report.discrepancy_counts.coverage_mismatch, 1);
});

Deno.test("batch advisory audit: limit is enforced in helper normalization/reporting", () => {
  const normalized = normalizeBatchAdvisoryAuditInput({ uploaded_file_ids: ["uf-1", "uf-1", "uf-2"], limit: 1 });
  assertEquals(normalized.uploaded_file_ids, ["uf-1", "uf-2"]);
  assertEquals(normalized.limit, 1);
  const report = buildBatchAdvisoryAuditReport({ audits: [audit({ auditId: "a1" }), audit({ auditId: "a2" })], input: normalized });
  assertEquals(report.total, 1);
});

Deno.test("batch advisory audit endpoint: read-only, org-scoped, and limit-capped", () => {
  const source = Deno.readTextFileSync("supabase/functions/document-intelligence-v3-advisory-audit-batch/index.ts");
  assert(source.includes("verifyUser(req)"));
  assert(source.includes("getUserOrgId(user.id, supabaseAdmin, req)"));
  assert(source.includes(".eq(\"org_id\", orgId)"));
  assert(source.includes("const MAX_BATCH_LIMIT = 25"));
  assert(!source.includes(".rpc(\"approve_lease_workflow\""));
  assert(!source.includes("functions/v1/review-approve"));
  assert(!source.includes(".insert("));
  assert(!source.includes(".update("));
  assert(!source.includes(".delete("));
});

Deno.test("batch advisory audit phase guard: approve_lease_workflow behavior is unchanged", () => {
  const source = Deno.readTextFileSync("supabase/functions/approve-lease-workflow/index.ts");
  assert(source.includes("supabaseAdmin.rpc(\"approve_lease_workflow\""));
  assert(!source.includes("document-intelligence-v3-advisory-audit-batch"));
  assert(!source.includes("batch_audit"));
});

Deno.test("batch advisory audit phase guard: Lease Review business rows are unchanged", () => {
  const source = Deno.readTextFileSync("src/pages/LeaseReview.jsx");
  assert(source.includes("const canApprove = approvalBlockers.length === 0;"));
  assert(source.includes("approveLeaseWorkflow({"));
  assert(!source.includes("document-intelligence-v3-advisory-audit-batch"));
  assert(!source.includes("batch_audit"));
  assert(!source.includes("V3 Batch Advisory Audit Report"));
});