// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCoverageAndImportanceDiagnostics,
  scoreFieldImportance,
  scoreClaimImportance,
} from "../_shared/extraction/document-intelligence-v3/coverage-importance.ts";
import { buildExtractionPlan } from "../_shared/extraction/document-intelligence-v3/profile-planner.ts";
import { getProfilePolicy } from "../_shared/extraction/document-intelligence-v3/profile-policy.ts";

Deno.test("coverage/importance: base_lease counts required fields and source-backed evidence", () => {
  const requiredFields = [
    { field_key: "tenant_name", required: true, status: "source_backed", value_present: true, source_backed: true, importance_level: "critical", importance_score: 95, importance_reasons: [] },
    { field_key: "landlord_name", required: true, status: "missing", value_present: false, source_backed: false, missing_reason: "not_attempted", importance_level: "critical", importance_score: 90, importance_reasons: [] },
  ];
  const diagnostic = buildCoverageAndImportanceDiagnostics({
    policyKey: "base_lease",
    policy: getProfilePolicy("base_lease"),
    claims: [{ id: "c1", claim_type: "canonical_field", canonical_field_candidates: ["tenant_name"], confidence: { composite: 0.9 } }],
    evidence: [{ claim_id: "c1", source_text: "Tenant: Acme", block_ids: ["b1"], polygon: [] }],
    validationDrops: [],
    requiredFields,
    optionalFields: [],
    extractionPlan: buildExtractionPlan("base_lease"),
    layoutSummary: { page_count: 2, pages_with_text: 2, text_block_count: 4, table_count: 1, page_markers_present: true, warnings: [] },
    evidenceSufficiencyCounts: { fields_with_text_only_evidence: 1 },
  });

  assertEquals(diagnostic.coverage.diagnostic_only, true);
  assertEquals(diagnostic.coverage.expected_information_coverage.expected_required_fields, 2);
  assertEquals(diagnostic.coverage.expected_information_coverage.found_required_fields, 1);
  assertEquals(diagnostic.coverage.expected_information_coverage.missing_required_fields, 1);
  assertEquals(diagnostic.coverage.evidence_coverage.claims_with_evidence, 1);
  assertEquals(diagnostic.coverage.evidence_coverage.source_backed_field_count, 1);
  assert(diagnostic.important_missing_fields.some((field: any) => field.field_key === "landlord_name"));
});

Deno.test("coverage/importance: assignment_assumption treats original lease as related-document coverage, not CAM blocker", () => {
  const plan = buildExtractionPlan("assignment_assumption");
  const requiredFields = [
    { field_key: "assignor_name", required: true, status: "missing", value_present: false, source_backed: false, importance_level: "critical", importance_score: 90, importance_reasons: [] },
  ];
  const diagnostic = buildCoverageAndImportanceDiagnostics({
    policyKey: "assignment_assumption",
    policy: getProfilePolicy("assignment_assumption"),
    claims: [],
    evidence: [],
    validationDrops: [],
    requiredFields,
    optionalFields: [{ field_key: "cam_amount", required: false, status: "missing", value_present: false, source_backed: false, importance_level: "medium", importance_score: 45, importance_reasons: ["optional_for_profile"] }],
    extractionPlan: plan,
    layoutSummary: {},
    evidenceSufficiencyCounts: {},
  });

  assertEquals(diagnostic.coverage.expected_information_coverage.expected_required_fields, 1);
  assertEquals(diagnostic.coverage.related_document_coverage.related_documents_missing, ["original_lease"]);
  assert(diagnostic.coverage.module_coverage.modules_skipped > 0);
  assert(diagnostic.important_related_documents_missing.some((doc: any) => doc.document_type === "original_lease"));
});

Deno.test("coverage/importance: assignment_assumption_amendment scores amendment-specific fields high", () => {
  const field = { field_key: "all_other_terms_remain_same", required: true, status: "missing", value_present: false, source_backed: false };
  const scored = scoreFieldImportance(field, "assignment_assumption_amendment");
  assert(["critical", "high"].includes(scored.importance_level));
  assert(scored.importance_reasons.includes("legal_impact"));
});

Deno.test("coverage/importance: unknown_cre_document does not inflate base lease fields", () => {
  const rent = scoreFieldImportance({ field_key: "monthly_rent", required: false, status: "missing" }, "unknown_cre_document");
  const documentType = scoreFieldImportance({ field_key: "document_type", required: true, status: "missing" }, "unknown_cre_document");
  assertEquals(rent.importance_level, "hidden_optional");
  assertEquals(documentType.importance_level, "high");
});

Deno.test("coverage/importance: non_cre_document avoids CRE importance inflation", () => {
  const rent = scoreFieldImportance({ field_key: "monthly_rent", required: false, status: "missing" }, "non_cre_document");
  const claim = scoreClaimImportance({ claim_type: "clause:rent", object: { label: "Rent", value: "$10" }, confidence: { composite: 0.9 } }, "non_cre_document");
  assertEquals(rent.importance_level, "hidden_optional");
  assert(["hidden_optional", "medium"].includes(claim.importance_level));
});

Deno.test("coverage/importance: validation drops and unmapped high-importance claims are surfaced", () => {
  const diagnostic = buildCoverageAndImportanceDiagnostics({
    policyKey: "base_lease",
    policy: getProfilePolicy("base_lease"),
    claims: [{ id: "c1", claim_type: "clause:termination", object: { label: "Termination", value: "Early termination right" }, canonical_field_candidates: [], confidence: { composite: 0.9 } }],
    evidence: [],
    validationDrops: [{ field_key: "monthly_rent", reason: "invalid_markup_value", bad_value: "<figure>", action: "dropped" }],
    requiredFields: [{ field_key: "monthly_rent", required: true, status: "missing", value_present: false, source_backed: false, validation_drop: { reason: "invalid_markup_value" }, importance_level: "critical", importance_score: 95, importance_reasons: ["validation_drop"] }],
    optionalFields: [],
    extractionPlan: buildExtractionPlan("base_lease"),
    layoutSummary: {},
    evidenceSufficiencyCounts: {},
  });

  assertEquals(diagnostic.coverage.validation_coverage.validation_drops_total, 1);
  assertEquals(diagnostic.coverage.validation_coverage.invalid_markup_values, 1);
  assert(diagnostic.important_validation_drops.some((drop: any) => drop.field_key === "monthly_rent"));
  assertEquals(diagnostic.unmapped_claims_count, 1);
  assert(diagnostic.unmapped_high_importance_claims.length > 0);
});