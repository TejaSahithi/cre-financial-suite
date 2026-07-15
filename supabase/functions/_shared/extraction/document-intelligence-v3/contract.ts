// @ts-nocheck
/**
 * Document Intelligence v3 — Contract Builders and Shape Validators (Phase 1 scaffold)
 *
 * Pure functions only: build an empty/default v3 contract skeleton, and
 * validate that a claim/evidence/contract object satisfies the required
 * shape from docs/document-intelligence-v3-baseline.md. Nothing here reads
 * or writes uploaded_files / leases — see adapter.ts for the (still
 * read-only) function that populates a skeleton from real rows.
 */

import type {
  DocumentIntelligenceV3Contract,
  DocumentIntelligenceV3VersionMetadata,
} from "./types.ts";

export const DOCUMENT_INTELLIGENCE_V3_CONTRACT_VERSION = "document_intelligence_v3.phase1";

export function buildDocumentIntelligenceV3VersionMetadata(
  overrides: Partial<DocumentIntelligenceV3VersionMetadata> = {},
): DocumentIntelligenceV3VersionMetadata {
  return {
    pipeline_version: null,
    layout_provider: null,
    layout_api_version: null,
    extraction_provider: null,
    extraction_model: null,
    prompt_bundle_version: null,
    ontology_version: null,
    validation_rules_version: null,
    profile_policy_version: null,
    ui_projection_version: null,
    content_hash: null,
    ...overrides,
  };
}

export function buildEmptyDocumentIntelligenceV3Contract(
  overrides: Partial<DocumentIntelligenceV3Contract> = {},
): DocumentIntelligenceV3Contract {
  const now = new Date().toISOString();

  const base: DocumentIntelligenceV3Contract = {
    contract_version: DOCUMENT_INTELLIGENCE_V3_CONTRACT_VERSION,
    document: {
      document_id: null,
      uploaded_file_id: null,
      lease_id: null,
      org_id: null,
      file_name: null,
      mime_type: null,
      module_type: null,
      document_subtype: null,
    },
    processing: {
      status: null,
      pipeline_job_id: null,
      started_at: null,
      finished_at: null,
      version: buildDocumentIntelligenceV3VersionMetadata(),
    },
    layout: {
      provider: null,
      api_version: null,
      page_count: null,
      page_markers_present: null,
      page_mapping_coverage: null,
    },
    profile: {
      profile_key: null,
      selected_profile_key: null,
      selected_policy_key: null,
      confidence: null,
      status: "unclassified",
      signals: {},
      suggested_profiles: [],
      candidates: [],
      disagreements: [],
      fallback_reason: null,
      profile_source: "fallback_unknown",
    },
    extraction_plan: {
      profile_key: null,
      modules_to_run: [],
      modules_skipped: [],
      related_documents_needed: [],
      expected_information_profile: [],
      planner_warnings: [],
      status: "planned",
      diagnostic_only: true,
    },
    entities: [],
    claims: [],
    canonical_fields: [],
    clauses: [],
    events: [],
    financial_schedules: [],
    relationships: [],
    risks: [],
    missing_information: [],
    conflicts: [],
    validation_drops: [],
    unmapped_claims: [],
    coverage: {
      processing_coverage: { pages_processed: 0, pages_total: 0, page_coverage_percent: 0, layout_available: false, page_markers_present: false, text_block_count: 0, table_count: 0, warning_count: 0 },
      evidence_coverage: { claims_total: 0, claims_with_evidence: 0, claims_without_evidence: 0, evidence_rows_total: 0, evidence_rows_with_source_text: 0, evidence_rows_with_block_ids: 0, evidence_rows_with_polygon: 0, source_backed_field_count: 0, evidence_sufficiency_counts: {} },
      expected_information_coverage: { expected_required_fields: 0, found_required_fields: 0, missing_required_fields: 0, expected_optional_fields: 0, found_optional_fields: 0, required_field_coverage_percent: 0, optional_field_coverage_percent: 0 },
      module_coverage: { modules_expected: 0, modules_completed: 0, modules_skipped: 0, modules_failed: 0, modules_not_run: 0, module_coverage_percent: 0 },
      field_coverage: { required_fields: [], optional_fields: [] },
      related_document_coverage: { related_documents_needed: [], related_documents_present: [], related_documents_missing: [], missing_related_document_reasons: {} },
      validation_coverage: { validation_drops_total: 0, fields_with_validation_drops: [], invalid_markup_values: 0, missing_source_evidence_count: 0, invalid_signature_date_source_count: 0, unsupported_inferred_value_count: 0 },
      overall_coverage: { coverage_level: "unavailable", coverage_percent: 0, coverage_reason: "not_evaluated", coverage_warnings: [] },
      diagnostic_only: true,
    },
    importance: {
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
    readiness: {
      approval_readiness: "not_started",
      budget_readiness: null,
      cam_readiness: null,
      expense_rules_readiness: null,
      blockers: [],
      advisories: [],
    },
    review: {
      status: "not_started",
      reviewer: null,
      reviewed_at: null,
    },
    audit: {
      created_at: now,
      created_by: null,
      source_contract_version: DOCUMENT_INTELLIGENCE_V3_CONTRACT_VERSION,
    },
  };

  return { ...base, ...overrides };
}

export const DOCUMENT_INTELLIGENCE_V3_TOP_LEVEL_SECTIONS: Array<keyof DocumentIntelligenceV3Contract> = [
  "contract_version",
  "document",
  "processing",
  "layout",
  "profile",
  "extraction_plan",
  "entities",
  "claims",
  "canonical_fields",
  "clauses",
  "events",
  "financial_schedules",
  "relationships",
  "risks",
  "missing_information",
  "conflicts",
  "validation_drops",
  "unmapped_claims",
  "coverage",
  "importance",
  "readiness",
  "review",
  "audit",
];

export interface ShapeValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDocumentIntelligenceV3ContractShape(contract: unknown): ShapeValidationResult {
  if (!contract || typeof contract !== "object") {
    return { valid: false, errors: ["contract must be an object"] };
  }
  const record = contract as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of DOCUMENT_INTELLIGENCE_V3_TOP_LEVEL_SECTIONS) {
    if (!(key in record)) errors.push(`missing top-level section: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

const ALLOWED_EXTRACTION_MODES = new Set([
  "explicit",
  "normalized",
  "inferred",
  "calculated",
  "resolved_from_multiple_sources",
  "reviewer_entered",
]);

const ALLOWED_SUPPORT_TYPES = new Set([
  "direct_quote",
  "table_cell",
  "visual",
  "calculated",
  "cross_reference",
  "multi_source",
]);

const REQUIRED_EVIDENCE_FIELDS = [
  "document_id",
  "uploaded_file_id",
  "page",
  "source_text",
  "block_ids",
  "polygon",
  "support_type",
];

const REQUIRED_CLAIM_FIELDS = [
  "claim_id",
  "claim_type",
  "subject",
  "predicate",
  "object",
  "conditions",
  "effective_period",
  "extraction_mode",
  "confidence",
  "evidence",
  "canonical_field_candidates",
  "validation",
  "importance",
  "supersession",
];

export function validateDocumentIntelligenceV3Evidence(evidence: unknown): ShapeValidationResult {
  if (!evidence || typeof evidence !== "object") {
    return { valid: false, errors: ["evidence must be an object"] };
  }
  const e = evidence as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of REQUIRED_EVIDENCE_FIELDS) {
    if (!(key in e)) errors.push(`evidence missing field: ${key}`);
  }
  if ("support_type" in e && !ALLOWED_SUPPORT_TYPES.has(String(e.support_type))) {
    errors.push(`evidence.support_type is not an allowed value: ${String(e.support_type)}`);
  }
  if ("block_ids" in e && !Array.isArray(e.block_ids)) errors.push("evidence.block_ids must be an array");
  if ("polygon" in e && !Array.isArray(e.polygon)) errors.push("evidence.polygon must be an array");

  return { valid: errors.length === 0, errors };
}

export function validateDocumentIntelligenceV3Claim(claim: unknown): ShapeValidationResult {
  if (!claim || typeof claim !== "object") {
    return { valid: false, errors: ["claim must be an object"] };
  }
  const c = claim as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of REQUIRED_CLAIM_FIELDS) {
    if (!(key in c)) errors.push(`claim missing field: ${key}`);
  }
  if ("extraction_mode" in c && !ALLOWED_EXTRACTION_MODES.has(String(c.extraction_mode))) {
    errors.push(`claim.extraction_mode is not an allowed value: ${String(c.extraction_mode)}`);
  }
  if ("evidence" in c) {
    if (!Array.isArray(c.evidence)) {
      errors.push("claim.evidence must be an array");
    } else {
      (c.evidence as unknown[]).forEach((ev, i) => {
        const result = validateDocumentIntelligenceV3Evidence(ev);
        if (!result.valid) errors.push(...result.errors.map((msg) => `evidence[${i}]: ${msg}`));
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

