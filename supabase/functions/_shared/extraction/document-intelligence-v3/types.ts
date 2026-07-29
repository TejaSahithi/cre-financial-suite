// @ts-nocheck
/**
 * Document Intelligence v3 — Contract Types (Phase 1 scaffold)
 *
 * Structural types for the `document_intelligence_v3` contract described in
 * docs/lease-extraction-architecture-audit-2026-07-29.md. This module defines shape only.
 * It does not run, parse, or replace any part of the current legacy_hybrid /
 * openai_fact_ledger extraction pipeline, and nothing else in the runtime
 * pipeline imports it yet — see feature-flag.ts (gate) and adapter.ts
 * (read-only skeleton builder) for the only two Phase 1 consumers.
 *
 * @ts-nocheck matches the convention already used by every file in the
 * sibling openai-fact-ledger/ module, since this scaffold's job is to model
 * the same kind of loosely-shaped, JSONB-sourced data those modules do.
 */

// ── Top-level contract ───────────────────────────────────────────────────────

export type DocumentIntelligenceV3ContractVersion = "document_intelligence_v3.phase1";

export interface DocumentIntelligenceV3VersionMetadata {
  pipeline_version: string | null;
  layout_provider: string | null;
  layout_api_version: string | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  prompt_bundle_version: string | null;
  ontology_version: string | null;
  validation_rules_version: string | null;
  profile_policy_version: string | null;
  ui_projection_version: string | null;
  content_hash: string | null;
}

export interface DocumentIntelligenceV3DocumentSection {
  document_id: string | null;
  uploaded_file_id: string | null;
  lease_id: string | null;
  org_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  module_type: string | null;
  document_subtype: string | null;
}

export interface DocumentIntelligenceV3ProcessingSection {
  status: string | null;
  pipeline_job_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  version: DocumentIntelligenceV3VersionMetadata;
}

export interface DocumentIntelligenceV3LayoutSection {
  provider: string | null;
  api_version: string | null;
  page_count: number | null;
  page_markers_present: boolean | null;
  page_mapping_coverage: number | null;
}

export type DocumentIntelligenceV3ProfileSource =
  | "openai_fact_ledger"
  | "vertex_fact_ledger"
  | "deterministic_rules"
  | "canonical_layout_signals"
  | "existing_payload"
  | "manual_override"
  | "fallback_unknown";

export interface DocumentIntelligenceV3ProfileCandidate {
  profile_key: string;
  confidence: number;
  signals: Record<string, unknown>;
  source: DocumentIntelligenceV3ProfileSource;
}

export interface DocumentIntelligenceV3ProfileSection {
  profile_key: string | null;
  selected_profile_key: string | null;
  selected_policy_key: string | null;
  confidence: number | null;
  status: "unclassified" | "auto_detected" | "manual_override" | "needs_review" | "not_applicable";
  signals: Record<string, unknown>;
  suggested_profiles: string[];
  candidates: DocumentIntelligenceV3ProfileCandidate[];
  disagreements: unknown[];
  fallback_reason: string | null;
  profile_source: DocumentIntelligenceV3ProfileSource;
}

export interface DocumentIntelligenceV3ExtractionPlanModule {
  module_key: string;
  reason: string;
  priority: number;
  expected_outputs: string[];
  page_hints: string[];
  status: "planned" | "skipped" | "not_applicable" | string;
}

export interface DocumentIntelligenceV3ExtractionPlanSection {
  profile_key: string | null;
  modules_to_run: DocumentIntelligenceV3ExtractionPlanModule[];
  modules_skipped: DocumentIntelligenceV3ExtractionPlanModule[];
  related_documents_needed: string[];
  expected_information_profile: string[];
  planner_warnings: string[];
  status: "planned" | "not_applicable" | string;
  diagnostic_only: boolean;
}

export interface DocumentIntelligenceV3Entity {
  entity_id: string;
  role: string | null;
  display_name: string | null;
}

// ── Claim / evidence model (Task E) ─────────────────────────────────────────

export type ClaimExtractionMode =
  | "explicit"
  | "normalized"
  | "inferred"
  | "calculated"
  | "resolved_from_multiple_sources"
  | "reviewer_entered";

export type EvidenceSupportType =
  | "direct_quote"
  | "table_cell"
  | "visual"
  | "calculated"
  | "cross_reference"
  | "multi_source";

/** A forward reference to the future Document Package Graph node
 *  (docs/lease-extraction-architecture-audit-2026-07-29.md, Section 6) — not yet a real
 *  table, so `document_id` stays a plain identifier here, distinct from the
 *  concrete, already-real `uploaded_file_id`. */
export interface DocumentIntelligenceV3Evidence {
  document_id: string | null;
  uploaded_file_id: string | null;
  page: number | null;
  source_text: string | null;
  block_ids: string[];
  polygon: number[];
  support_type: EvidenceSupportType;
}

export interface DocumentIntelligenceV3ClaimConfidence {
  composite: number;
  [key: string]: number;
}

export interface DocumentIntelligenceV3ClaimValidation {
  status: "pending" | "passed" | "failed";
  evidence_sufficiency: "strong" | "partial" | "weak" | "none";
  rules: string[];
}

export interface DocumentIntelligenceV3ClaimSupersession {
  supersedes_claim_id: string | null;
  superseded_by_claim_id: string | null;
  current_status: "current" | "superseded" | "unknown";
  changed_by_document: string | null;
}

export interface DocumentIntelligenceV3Claim {
  claim_id: string;
  claim_type: string;
  subject: { entity_id?: string | null; role?: string | null; display_name?: string | null } | null;
  predicate: string;
  object: Record<string, unknown> | null;
  conditions: unknown[];
  effective_period: { from: string | null; to: string | null };
  extraction_mode: ClaimExtractionMode;
  confidence: DocumentIntelligenceV3ClaimConfidence;
  evidence: DocumentIntelligenceV3Evidence[];
  canonical_field_candidates: string[];
  validation: DocumentIntelligenceV3ClaimValidation;
  importance: number | null;
  supersession: DocumentIntelligenceV3ClaimSupersession;
}

// ── Canonical fields (projections from claims) ──────────────────────────────

export interface DocumentIntelligenceV3CanonicalField {
  field_key: string;
  value: unknown;
  normalized_value: unknown;
  status: "missing" | "auto_populated" | "needs_review" | "reviewer_confirmed" | "reviewer_edited";
  source_claim_ids: string[];
  source_page: number | null;
  source_text: string | null;
  confidence: number | null;
  extraction_mode: ClaimExtractionMode | null;
  validation_status: "pending" | "passed" | "failed";
  canonical_tab: string | null;
  profile_relevance: "required" | "advisory" | "not_applicable";
}

export interface DocumentIntelligenceV3ValidationDrop {
  field_key: string | null;
  bad_value: unknown;
  reason: string;
  source_text: string | null;
  action: "dropped" | "flagged";
}

// ── Coverage / importance / readiness / review / audit ──────────────────────

export interface DocumentIntelligenceV3CoverageSection {
  processing_coverage: Record<string, unknown>;
  evidence_coverage: Record<string, unknown>;
  expected_information_coverage: Record<string, unknown>;
  module_coverage: Record<string, unknown>;
  field_coverage: Record<string, unknown>;
  related_document_coverage: Record<string, unknown>;
  validation_coverage: Record<string, unknown>;
  overall_coverage: Record<string, unknown>;
  diagnostic_only: boolean;
}

export type DocumentIntelligenceV3ImportanceLevel = "critical" | "high" | "medium" | "low" | "hidden_optional";

export interface DocumentIntelligenceV3ImportanceSection {
  diagnostic_only: boolean;
  field_counts_by_importance: Record<DocumentIntelligenceV3ImportanceLevel, number>;
  critical_missing_fields_count: number;
  high_missing_fields_count: number;
  important_validation_drops_count: number;
  high_importance_advisories_count: number;
  unmapped_claims_count: number;
  unmapped_high_importance_claims_count: number;
  important_related_documents_missing: unknown[];
}

export interface DocumentIntelligenceV3ReadinessSection {
  approval_readiness: "not_started" | "needs_review" | "ready" | "blocked";
  budget_readiness: string | null;
  cam_readiness: string | null;
  expense_rules_readiness: string | null;
  blockers: Array<{ field_key: string; reason: string }>;
  advisories: Array<{ module: string; message: string }>;
}

export interface DocumentIntelligenceV3ReviewSection {
  status: "not_started" | "in_progress" | "completed";
  reviewer: string | null;
  reviewed_at: string | null;
}

export interface DocumentIntelligenceV3AuditSection {
  created_at: string;
  created_by: string | null;
  source_contract_version: DocumentIntelligenceV3ContractVersion;
}

// ── Full contract ────────────────────────────────────────────────────────────

export interface DocumentIntelligenceV3Contract {
  contract_version: DocumentIntelligenceV3ContractVersion;
  document: DocumentIntelligenceV3DocumentSection;
  processing: DocumentIntelligenceV3ProcessingSection;
  layout: DocumentIntelligenceV3LayoutSection;
  profile: DocumentIntelligenceV3ProfileSection;
  extraction_plan: DocumentIntelligenceV3ExtractionPlanSection;
  entities: DocumentIntelligenceV3Entity[];
  claims: DocumentIntelligenceV3Claim[];
  canonical_fields: DocumentIntelligenceV3CanonicalField[];
  clauses: unknown[];
  events: unknown[];
  financial_schedules: unknown[];
  relationships: unknown[];
  risks: unknown[];
  missing_information: unknown[];
  conflicts: unknown[];
  validation_drops: DocumentIntelligenceV3ValidationDrop[];
  unmapped_claims: DocumentIntelligenceV3Claim[];
  coverage: DocumentIntelligenceV3CoverageSection;
  importance: DocumentIntelligenceV3ImportanceSection;
  readiness: DocumentIntelligenceV3ReadinessSection;
  review: DocumentIntelligenceV3ReviewSection;
  audit: DocumentIntelligenceV3AuditSection;
}

