// @ts-nocheck
/**
 * Document Intelligence v3 - Coverage and Importance Diagnostics (Phase 10).
 *
 * Diagnostic-only. This module measures extraction completeness and risk
 * importance from already-persisted v3 rows. It does not change approval,
 * extraction execution, Lease Review rows, or provider selection.
 */

import { getProfilePolicy, resolvePolicyKey } from "./profile-policy.ts";

export const IMPORTANCE_LEVELS = ["critical", "high", "medium", "low", "hidden_optional"] as const;

const FINANCIAL_FIELDS = new Set([
  "monthly_rent",
  "annual_rent",
  "rent_schedule",
  "security_deposit",
  "expense_structure",
  "cam_amount",
  "cam_cap_pct",
  "cam_recoverable",
  "tenant_pro_rata_share",
  "tax_responsibility",
  "allowance_amount",
  "termination_fee",
  "amended_base_rent_for_additional_year",
]);

const DEADLINE_FIELDS = new Set([
  "commencement_date",
  "expiration_date",
  "rent_commencement_date",
  "assignment_effective_date",
  "amendment_effective_date",
  "renewal_effective_date",
  "termination_date",
  "surrender_date",
  "notice_date",
  "substantial_completion_date",
  "amended_expiration_date",
]);

const PARTY_FIELDS = new Set([
  "tenant_name",
  "landlord_name",
  "assignor_name",
  "assignee_name",
  "guarantor_name",
  "lender_name",
  "sender_name",
  "recipient_name",
]);

const LEGAL_FIELDS = new Set([
  "lease_type",
  "landlord_consent",
  "assumption_scope",
  "all_other_terms_remain_same",
  "amendment_terms",
  "guaranty_scope",
  "defaults",
  "options",
  "termination_options",
  "renewal_options",
  "tenant_signature_date",
  "landlord_signature_date",
]);

const BUDGET_CAM_FIELDS = new Set([
  "monthly_rent",
  "annual_rent",
  "rent_schedule",
  "lease_type",
  "expense_structure",
  "cam_amount",
  "cam_cap_pct",
  "cam_recoverable",
  "tenant_pro_rata_share",
  "building_rsf",
  "square_footage",
  "responsibility_insurance",
  "responsibility_utilities",
  "responsibility_repairs",
]);

const PROFILE_HIGH_IMPORTANCE_FIELDS: Record<string, Set<string>> = {
  base_lease: new Set([
    "tenant_name",
    "landlord_name",
    "property_address",
    "square_footage",
    "commencement_date",
    "expiration_date",
    "monthly_rent",
    "lease_type",
    "expense_structure",
    "cam_recoverable",
    "tenant_pro_rata_share",
  ]),
  assignment_assumption: new Set([
    "assignor_name",
    "assignee_name",
    "landlord_name",
    "assignment_effective_date",
    "original_lease_date",
    "landlord_consent",
    "assumption_scope",
    "assignee_notice_address",
    "tenant_signature_date",
    "landlord_signature_date",
  ]),
  assignment_assumption_amendment: new Set([
    "assignor_name",
    "assignee_name",
    "landlord_name",
    "assignment_effective_date",
    "original_lease_date",
    "landlord_consent",
    "assumption_scope",
    "assignee_notice_address",
    "tenant_signature_date",
    "landlord_signature_date",
    "amended_expiration_date",
    "amended_base_rent_for_additional_year",
    "all_other_terms_remain_same",
    "amendment_terms",
  ]),
  lease_assignment: new Set([
    "assignor_name",
    "assignee_name",
    "assignment_effective_date",
    "original_lease_date",
    "landlord_consent",
  ]),
  lease_amendment: new Set([
    "document_type",
    "landlord_name",
    "tenant_name",
    "original_lease_date",
    "amendment_effective_date",
    "all_other_terms_remain_same",
  ]),
  unknown_cre_document: new Set(["document_type", "profile_key", "selected_policy_key"]),
};

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function percent(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return clamp((numerator / denominator) * 100);
}

function uniq(values: any[]): string[] {
  return [...new Set((values || []).filter((v) => v != null && String(v).trim()).map((v) => String(v).trim()))];
}

function levelFromScore(score: number, hidden = false): string {
  if (hidden) return "hidden_optional";
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function highestImportance(items: any[]): string {
  const order = { critical: 5, high: 4, medium: 3, low: 2, hidden_optional: 1 };
  return (items || []).reduce((best, item) => (order[item?.importance_level] > order[best] ? item.importance_level : best), "hidden_optional");
}

function compactClaim(claim: any, importance: any) {
  return {
    claim_id: claim.id ?? null,
    claim_type: claim.claim_type ?? null,
    label: claim.object?.label ?? null,
    value: claim.object?.value ?? claim.object?.field_key ?? null,
    canonical_field_candidates: Array.isArray(claim.canonical_field_candidates) ? claim.canonical_field_candidates : [],
    importance_level: importance.importance_level,
    importance_score: importance.importance_score,
    importance_reasons: importance.importance_reasons,
  };
}

function relatedDocumentReasons(relatedDocumentsNeeded: string[], plannerWarnings: string[]) {
  const warnings = Array.isArray(plannerWarnings) ? plannerWarnings : [];
  const result: Record<string, string[]> = {};
  for (const doc of relatedDocumentsNeeded) {
    result[doc] = warnings.length ? warnings : [`${doc}_not_linked_in_v3_package_graph`];
  }
  return result;
}

function coverageLevel(coveragePercent: number, warnings: string[]) {
  if (coveragePercent <= 0) return "unavailable";
  if (coveragePercent >= 90 && warnings.length === 0) return "complete";
  if (coveragePercent >= 70) return "substantial";
  if (coveragePercent >= 35) return "partial";
  return "minimal";
}

export function scoreFieldImportance(field: any, profileKeyInput: string | null | undefined) {
  const profileKey = resolvePolicyKey(profileKeyInput);
  const fieldKey = String(field?.field_key ?? "");
  const required = !!field?.required;
  const reasons = new Set<string>();
  let score = required ? 45 : 12;

  if (profileKey === "non_cre_document") {
    return {
      importance_level: required && fieldKey === "document_type" ? "medium" : "hidden_optional",
      importance_score: required && fieldKey === "document_type" ? 35 : 0,
      importance_reasons: required && fieldKey === "document_type" ? ["profile_confirmation"] : ["not_applicable_for_profile"],
    };
  }

  if (profileKey === "unknown_cre_document") {
    if (PROFILE_HIGH_IMPORTANCE_FIELDS.unknown_cre_document.has(fieldKey)) {
      return {
        importance_level: "high",
        importance_score: 70,
        importance_reasons: ["profile_confirmation"],
      };
    }
    return {
      importance_level: required ? "medium" : "hidden_optional",
      importance_score: required ? 35 : 5,
      importance_reasons: required ? ["profile_relevance_unknown"] : ["optional_for_profile"],
    };
  }

  if (required) reasons.add("required_for_profile");
  else reasons.add("optional_for_profile");

  if (PROFILE_HIGH_IMPORTANCE_FIELDS[profileKey]?.has(fieldKey)) {
    score += required ? 28 : 18;
    reasons.add("profile_relevant_high_importance");
  }
  if (FINANCIAL_FIELDS.has(fieldKey)) {
    score += 18;
    reasons.add("financial_term");
  }
  if (DEADLINE_FIELDS.has(fieldKey)) {
    score += 16;
    reasons.add("deadline_term");
  }
  if (PARTY_FIELDS.has(fieldKey)) {
    score += 14;
    reasons.add("party_identity");
  }
  if (LEGAL_FIELDS.has(fieldKey)) {
    score += 16;
    reasons.add("legal_impact");
  }
  if (BUDGET_CAM_FIELDS.has(fieldKey)) {
    score += 12;
    reasons.add(fieldKey.includes("cam") ? "needed_for_cam" : "needed_for_budget");
  }
  if (fieldKey === "original_lease_date" || fieldKey === "original_lease_reference") {
    score += 12;
    reasons.add("original_lease_required");
  }
  if (field?.status === "needs_review" || field?.missing_reason === "missing_source_evidence") {
    score += 10;
    reasons.add("missing_evidence");
  }
  if (field?.validation_drop) {
    score += 14;
    reasons.add("validation_drop");
  }
  if (typeof field?.confidence === "number" && field.confidence < 0.7) {
    score += 8;
    reasons.add("low_confidence");
  }
  if (field?.extraction_mode === "inferred") {
    score += 6;
    reasons.add("extraction_mode_inferred");
  }

  return {
    importance_level: levelFromScore(score),
    importance_score: clamp(score),
    importance_reasons: [...reasons].sort(),
  };
}

export function scoreClaimImportance(claim: any, profileKeyInput: string | null | undefined) {
  const profileKey = resolvePolicyKey(profileKeyInput);
  const text = [
    claim?.claim_type,
    claim?.object?.field_key,
    claim?.object?.label,
    claim?.object?.value,
    ...(Array.isArray(claim?.canonical_field_candidates) ? claim.canonical_field_candidates : []),
  ].join(" ").toLowerCase();
  const reasons = new Set<string>();
  let score = profileKey === "non_cre_document" ? 5 : 20;

  if (profileKey === "non_cre_document") reasons.add("not_applicable_for_profile");
  if (/rent|cam|tax|expense|fee|deposit|allowance|money/.test(text)) {
    score += 35;
    reasons.add("financial_term");
  }
  if (/date|deadline|commencement|expiration|termination|renewal|effective/.test(text)) {
    score += 20;
    reasons.add("deadline_term");
  }
  if (/consent|assignment|assumption|amendment|default|option|signature|guarant|termination|renewal/.test(text)) {
    score += 28;
    reasons.add("legal_impact");
  }
  if (/cam|budget|recover/.test(text)) {
    score += 14;
    reasons.add("downstream_cam_budget_impact");
  }
  const confidence = Number(claim?.confidence?.composite ?? claim?.confidence ?? 1);
  if (Number.isFinite(confidence) && confidence < 0.7) {
    score += 8;
    reasons.add("low_confidence");
  }
  if (claim?.extraction_mode === "inferred") {
    score += 6;
    reasons.add("extraction_mode_inferred");
  }

  if (reasons.size === 0) reasons.add("unmapped_claim");
  const hidden = profileKey === "non_cre_document" && score < 35;
  return {
    importance_level: levelFromScore(score, hidden),
    importance_score: clamp(score),
    importance_reasons: [...reasons].sort(),
  };
}

export function buildStaticCoverageImportanceSummary(args: {
  claims?: any[];
  evidence?: any[];
  validationDrops?: any[];
  layoutSummary?: any;
  extractionPlan?: any;
  profileKey?: string | null;
}) {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const evidence = Array.isArray(args.evidence) ? args.evidence : [];
  const validationDrops = Array.isArray(args.validationDrops) ? args.validationDrops : [];
  const layoutSummary = args.layoutSummary && typeof args.layoutSummary === "object" ? args.layoutSummary : {};
  const extractionPlan = args.extractionPlan && typeof args.extractionPlan === "object" ? args.extractionPlan : {};
  const relatedDocumentsNeeded = Array.isArray(extractionPlan.related_documents_needed) ? extractionPlan.related_documents_needed : [];
  const dynamicClaims = claims.filter((claim) => claim?.claim_type !== "canonical_field" || !(claim?.canonical_field_candidates || []).length);
  const unmappedHighImportanceClaims = dynamicClaims
    .map((claim) => ({ claim, importance: scoreClaimImportance(claim, args.profileKey) }))
    .filter(({ importance }) => ["critical", "high"].includes(importance.importance_level))
    .map(({ claim, importance }) => compactClaim(claim, importance));

  return {
    diagnostic_only: true,
    processing_coverage: {
      pages_processed: layoutSummary.pages_with_text ?? layoutSummary.page_count ?? 0,
      pages_total: layoutSummary.page_count ?? 0,
      page_coverage_percent: percent(layoutSummary.pages_with_text ?? layoutSummary.page_count ?? 0, layoutSummary.page_count ?? 0),
      layout_available: Object.keys(layoutSummary).length > 0,
      page_markers_present: Boolean(layoutSummary.page_markers_present),
      text_block_count: layoutSummary.text_block_count ?? 0,
      table_count: layoutSummary.table_count ?? 0,
      warning_count: Array.isArray(layoutSummary.warnings) ? layoutSummary.warnings.length : 0,
    },
    evidence_coverage: {
      claims_total: claims.length,
      claims_with_evidence: new Set(evidence.map((row) => row.claim_id).filter(Boolean)).size,
      claims_without_evidence: Math.max(0, claims.length - new Set(evidence.map((row) => row.claim_id).filter(Boolean)).size),
      evidence_rows_total: evidence.length,
      evidence_rows_with_source_text: evidence.filter((row) => typeof row?.source_text === "string" && row.source_text.trim()).length,
      evidence_rows_with_block_ids: evidence.filter((row) => Array.isArray(row?.block_ids) && row.block_ids.length > 0).length,
      evidence_rows_with_polygon: evidence.filter((row) => Array.isArray(row?.polygon) && row.polygon.length > 0).length,
    },
    related_document_coverage: {
      related_documents_needed: relatedDocumentsNeeded,
      related_documents_present: [],
      related_documents_missing: relatedDocumentsNeeded,
      related_documents_candidate_found: [],
      missing_related_document_reasons: relatedDocumentReasons(relatedDocumentsNeeded, extractionPlan.planner_warnings ?? []),
    },
    validation_coverage: {
      validation_drops_total: validationDrops.length,
      fields_with_validation_drops: uniq(validationDrops.map((drop) => drop?.field_key)),
      invalid_markup_values: validationDrops.filter((drop) => String(drop?.reason ?? "").includes("invalid_markup")).length,
      missing_source_evidence_count: validationDrops.filter((drop) => String(drop?.reason ?? "") === "missing_source_evidence").length,
      invalid_signature_date_source_count: validationDrops.filter((drop) => String(drop?.reason ?? "") === "invalid_signature_date_source").length,
      unsupported_inferred_value_count: validationDrops.filter((drop) => String(drop?.reason ?? "") === "unsupported_inferred_value").length,
    },
    unmapped_claims_count: dynamicClaims.length,
    unmapped_high_importance_claims: unmappedHighImportanceClaims,
  };
}

export function buildCoverageAndImportanceDiagnostics(args: {
  run?: any;
  policyKey?: string | null;
  policy?: any;
  claims?: any[];
  evidence?: any[];
  validationDrops?: any[];
  requiredFields?: any[];
  optionalFields?: any[];
  extractionPlan?: any;
  layoutSummary?: any;
  evidenceSufficiencyCounts?: Record<string, number>;
}) {
  const policyKey = resolvePolicyKey(args.policyKey ?? args.run?.profile_key);
  const policy = args.policy ?? getProfilePolicy(policyKey);
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const evidence = Array.isArray(args.evidence) ? args.evidence : [];
  const validationDrops = Array.isArray(args.validationDrops) ? args.validationDrops : [];
  const requiredFields = Array.isArray(args.requiredFields) ? args.requiredFields : [];
  const optionalFields = Array.isArray(args.optionalFields) ? args.optionalFields : [];
  const fields = [...requiredFields, ...optionalFields];
  const extractionPlan = args.extractionPlan && typeof args.extractionPlan === "object" ? args.extractionPlan : {};
  const layoutSummary = args.layoutSummary && typeof args.layoutSummary === "object" ? args.layoutSummary : {};
  const relatedDocumentsNeeded = Array.isArray(extractionPlan.related_documents_needed) ? extractionPlan.related_documents_needed : [];
  const modulesToRun = Array.isArray(extractionPlan.modules_to_run) ? extractionPlan.modules_to_run : [];
  const modulesSkipped = Array.isArray(extractionPlan.modules_skipped) ? extractionPlan.modules_skipped : [];
  const evidenceClaimIds = new Set(evidence.map((row) => row.claim_id).filter(Boolean));
  const sourceBackedFieldCount = fields.filter((field) => field?.source_backed).length;
  const missingRequired = requiredFields.filter((field) => field?.status === "missing");
  const foundRequired = requiredFields.filter((field) => field?.value_present || field?.source_backed);
  const foundOptional = optionalFields.filter((field) => field?.value_present || field?.source_backed);
  const failedModules = modulesToRun.filter((module) => (module.expected_outputs || []).some((fieldKey) => validationDrops.some((drop) => drop?.field_key === fieldKey)));
  const completedModules = modulesToRun.filter((module) => (module.expected_outputs || []).some((fieldKey) => fields.some((field) => field.field_key === fieldKey && (field.value_present || field.source_backed))));
  const moduleNotRun = Math.max(0, modulesToRun.length - completedModules.length - failedModules.length);
  const staticSummary = buildStaticCoverageImportanceSummary({ claims, evidence, validationDrops, layoutSummary, extractionPlan, profileKey: policyKey });

  const processingCoverage = {
    ...staticSummary.processing_coverage,
    pages_processed: layoutSummary.pages_with_text ?? layoutSummary.page_count ?? 0,
  };

  const evidenceCoverage = {
    claims_total: claims.length,
    claims_with_evidence: evidenceClaimIds.size,
    claims_without_evidence: Math.max(0, claims.length - evidenceClaimIds.size),
    evidence_rows_total: evidence.length,
    evidence_rows_with_source_text: evidence.filter((row) => typeof row?.source_text === "string" && row.source_text.trim()).length,
    evidence_rows_with_block_ids: evidence.filter((row) => Array.isArray(row?.block_ids) && row.block_ids.length > 0).length,
    evidence_rows_with_polygon: evidence.filter((row) => Array.isArray(row?.polygon) && row.polygon.length > 0).length,
    source_backed_field_count: sourceBackedFieldCount,
    evidence_sufficiency_counts: args.evidenceSufficiencyCounts ?? {},
  };

  const expectedInformationCoverage = {
    expected_required_fields: requiredFields.length,
    found_required_fields: foundRequired.length,
    missing_required_fields: missingRequired.length,
    expected_optional_fields: optionalFields.length,
    found_optional_fields: foundOptional.length,
    required_field_coverage_percent: percent(foundRequired.length, requiredFields.length),
    optional_field_coverage_percent: percent(foundOptional.length, optionalFields.length),
  };

  const moduleCoverage = {
    modules_expected: modulesToRun.length + modulesSkipped.length,
    modules_completed: completedModules.length,
    modules_skipped: modulesSkipped.length,
    modules_failed: failedModules.length,
    modules_not_run: moduleNotRun,
    module_coverage_percent: percent(completedModules.length, modulesToRun.length),
  };

  const relatedDocumentCoverage = {
    related_documents_needed: relatedDocumentsNeeded,
    related_documents_present: [],
    related_documents_missing: relatedDocumentsNeeded,
    related_documents_candidate_found: [],
      missing_related_document_reasons: relatedDocumentReasons(relatedDocumentsNeeded, extractionPlan.planner_warnings ?? policy.planner_warnings ?? []),
  };

  const validationCoverage = {
    validation_drops_total: validationDrops.length,
    fields_with_validation_drops: uniq(validationDrops.map((drop) => drop?.field_key)),
    invalid_markup_values: validationDrops.filter((drop) => String(drop?.reason ?? "").includes("invalid_markup")).length,
    missing_source_evidence_count: fields.filter((field) => field?.missing_reason === "missing_source_evidence").length + validationDrops.filter((drop) => String(drop?.reason ?? "") === "missing_source_evidence").length,
    invalid_signature_date_source_count: validationDrops.filter((drop) => String(drop?.reason ?? "") === "invalid_signature_date_source").length,
    unsupported_inferred_value_count: validationDrops.filter((drop) => String(drop?.reason ?? "") === "unsupported_inferred_value").length,
  };

  const componentPercents = [
    processingCoverage.layout_available ? processingCoverage.page_coverage_percent : 0,
    evidenceCoverage.claims_total ? percent(evidenceCoverage.claims_with_evidence, evidenceCoverage.claims_total) : 0,
    expectedInformationCoverage.expected_required_fields ? expectedInformationCoverage.required_field_coverage_percent : 100,
    moduleCoverage.modules_expected ? moduleCoverage.module_coverage_percent : 0,
    relatedDocumentCoverage.related_documents_needed.length ? percent(relatedDocumentCoverage.related_documents_present.length, relatedDocumentCoverage.related_documents_needed.length) : 100,
  ];
  const coveragePercent = percent(componentPercents.reduce((sum, value) => sum + value, 0), componentPercents.length * 100);
  const coverageWarnings = [
    ...(processingCoverage.layout_available ? [] : ["layout_unavailable"]),
    ...(missingRequired.length ? ["required_fields_missing"] : []),
    ...(evidenceCoverage.claims_without_evidence > 0 ? ["claims_missing_evidence"] : []),
    ...(relatedDocumentCoverage.related_documents_missing.length ? relatedDocumentCoverage.related_documents_missing.map((doc) => `missing_related_document:${doc}`) : []),
    ...(validationDrops.length ? ["validation_drops_present"] : []),
  ];

  const overallCoverage = {
    coverage_level: coverageLevel(coveragePercent, coverageWarnings),
    coverage_percent: coveragePercent,
    coverage_reason: coverageWarnings.length ? coverageWarnings[0] : "coverage_substantial_or_complete",
    coverage_warnings: coverageWarnings,
  };

  const coverage = {
    processing_coverage: processingCoverage,
    evidence_coverage: evidenceCoverage,
    expected_information_coverage: expectedInformationCoverage,
    module_coverage: moduleCoverage,
    field_coverage: {
      required_fields: requiredFields.map((field) => ({ field_key: field.field_key, status: field.status, importance_level: field.importance_level })),
      optional_fields: optionalFields.map((field) => ({ field_key: field.field_key, status: field.status, importance_level: field.importance_level })),
    },
    related_document_coverage: relatedDocumentCoverage,
    validation_coverage: validationCoverage,
    overall_coverage: overallCoverage,
    diagnostic_only: true,
  };

  const importantMissingFields = fields
    .filter((field) => ["critical", "high"].includes(field?.importance_level) && field?.status === "missing")
    .map((field) => ({
      field_key: field.field_key,
      required: !!field.required,
      status: field.status,
      missing_reason: field.missing_reason,
      importance_level: field.importance_level,
      importance_score: field.importance_score,
      importance_reasons: field.importance_reasons,
    }));

  const importantValidationDrops = validationDrops
    .map((drop) => {
      const field = fields.find((candidate) => candidate.field_key === drop.field_key) ?? { field_key: drop.field_key, required: policy.required_fields?.includes(drop.field_key), validation_drop: drop };
      const importance = field.importance_level ? field : scoreFieldImportance(field, policyKey);
      return {
        field_key: drop.field_key,
        reason: drop.reason,
        bad_value: drop.bad_value,
        action: drop.action,
        importance_level: importance.importance_level,
        importance_score: importance.importance_score,
        importance_reasons: importance.importance_reasons,
      };
    })
    .filter((drop) => ["critical", "high"].includes(drop.importance_level));

  const unmappedClaims = claims.filter((claim) => claim?.claim_type !== "canonical_field" || !(claim?.canonical_field_candidates || []).length);
  const unmappedHighImportanceClaims = unmappedClaims
    .map((claim) => ({ claim, importance: scoreClaimImportance(claim, policyKey) }))
    .filter(({ importance }) => ["critical", "high"].includes(importance.importance_level))
    .map(({ claim, importance }) => compactClaim(claim, importance));

  const highImportanceAdvisories = [];
  if (policy.advisory_message) {
    const advisoryFields = fields.filter((field) => (policy.advisory_fields || []).includes(field.field_key));
    highImportanceAdvisories.push({
      message: policy.advisory_message,
      fields: policy.advisory_fields || [],
      importance_level: relatedDocumentsNeeded.length ? "high" : highestImportance(advisoryFields),
      importance_score: relatedDocumentsNeeded.length ? 70 : Math.max(...advisoryFields.map((field) => field.importance_score ?? 0), 25),
      importance_reasons: relatedDocumentsNeeded.length ? ["missing_related_document_dependency", "original_lease_required"] : ["optional_for_profile"],
    });
  }

  const importanceSummary = {
    diagnostic_only: true,
    field_counts_by_importance: IMPORTANCE_LEVELS.reduce((acc: Record<string, number>, level) => {
      acc[level] = fields.filter((field) => field.importance_level === level).length;
      return acc;
    }, {}),
    critical_missing_fields_count: importantMissingFields.filter((field) => field.importance_level === "critical").length,
    high_missing_fields_count: importantMissingFields.filter((field) => field.importance_level === "high").length,
    important_validation_drops_count: importantValidationDrops.length,
    high_importance_advisories_count: highImportanceAdvisories.filter((advisory) => ["critical", "high"].includes(advisory.importance_level)).length,
    unmapped_claims_count: unmappedClaims.length,
    unmapped_high_importance_claims_count: unmappedHighImportanceClaims.length,
    important_related_documents_missing: relatedDocumentCoverage.related_documents_missing.map((doc) => ({
      document_type: doc,
      importance_level: "high",
      importance_score: 70,
      importance_reasons: ["missing_related_document_dependency", doc === "original_lease" ? "original_lease_required" : "related_document_required"],
    })),
  };

  return {
    coverage,
    importance_summary: importanceSummary,
    high_importance_advisories: highImportanceAdvisories,
    important_missing_fields: importantMissingFields,
    important_validation_drops: importantValidationDrops,
    unmapped_claims_count: unmappedClaims.length,
    unmapped_high_importance_claims: unmappedHighImportanceClaims,
    important_related_documents_missing: importanceSummary.important_related_documents_missing,
    related_document_coverage: relatedDocumentCoverage,
  };
}

export function emptyCoverageImportanceDiagnostics() {
  const coverage = {
    processing_coverage: { pages_processed: 0, pages_total: 0, page_coverage_percent: 0, layout_available: false, page_markers_present: false, text_block_count: 0, table_count: 0, warning_count: 0 },
    evidence_coverage: { claims_total: 0, claims_with_evidence: 0, claims_without_evidence: 0, evidence_rows_total: 0, evidence_rows_with_source_text: 0, evidence_rows_with_block_ids: 0, evidence_rows_with_polygon: 0, source_backed_field_count: 0, evidence_sufficiency_counts: {} },
    expected_information_coverage: { expected_required_fields: 0, found_required_fields: 0, missing_required_fields: 0, expected_optional_fields: 0, found_optional_fields: 0, required_field_coverage_percent: 0, optional_field_coverage_percent: 0 },
    module_coverage: { modules_expected: 0, modules_completed: 0, modules_skipped: 0, modules_failed: 0, modules_not_run: 0, module_coverage_percent: 0 },
    field_coverage: { required_fields: [], optional_fields: [] },
    related_document_coverage: { related_documents_needed: [], related_documents_present: [], related_documents_missing: [], related_documents_candidate_found: [], missing_related_document_reasons: {} },
    validation_coverage: { validation_drops_total: 0, fields_with_validation_drops: [], invalid_markup_values: 0, missing_source_evidence_count: 0, invalid_signature_date_source_count: 0, unsupported_inferred_value_count: 0 },
    overall_coverage: { coverage_level: "unavailable", coverage_percent: 0, coverage_reason: "no_completed_run", coverage_warnings: ["no_completed_run"] },
    diagnostic_only: true,
  };
  return {
    coverage,
    importance_summary: {
      diagnostic_only: true,
      field_counts_by_importance: { critical: 0, high: 0, medium: 0, low: 0, hidden_optional: 0 },
      critical_missing_fields_count: 0,
      high_missing_fields_count: 0,
      important_validation_drops_count: 0,
      high_importance_advisories_count: 0,
      unmapped_claims_count: 0,
      unmapped_high_importance_claims_count: 0,
      important_related_documents_missing: [],
    },
    high_importance_advisories: [],
    important_missing_fields: [],
    important_validation_drops: [],
    unmapped_claims_count: 0,
    unmapped_high_importance_claims: [],
    important_related_documents_missing: [],
    related_document_coverage: coverage.related_document_coverage,
  };
}