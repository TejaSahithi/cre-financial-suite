import { describe, expect, it } from "vitest";
import {
  resolveUploadedFileIdForV3Diagnostics,
  summarizeV3Diagnostics,
  summarizeLayoutSummary,
  summarizeEvidenceAnchorDiagnostics,
  summarizeEvidenceSufficiencyCounts,
  buildV3DiagnosticsFilename,
  buildV3AdvisoryAuditFilename,
  buildV3AdvisoryAuditBatchFilename,
  summarizeAdvisoryAudit,
  summarizeAdvisoryAuditBatch,
  DOCUMENT_INTELLIGENCE_V3_NOT_AVAILABLE_MESSAGE,
} from "../documentIntelligenceV3Diagnostics";

// â”€â”€ resolveUploadedFileIdForV3Diagnostics (Task 8: defensive resolution) â”€â”€â”€â”€

describe("resolveUploadedFileIdForV3Diagnostics", () => {
  it("prefers lease.source_file_id first", () => {
    const lease = { source_file_id: "uf-1", extraction_data: { source_file_id: "uf-2" } };
    expect(resolveUploadedFileIdForV3Diagnostics(lease, null)).toBe("uf-1");
  });

  it("falls back to extraction_data.source_file_id, then extraction_data.uploaded_file_id", () => {
    expect(resolveUploadedFileIdForV3Diagnostics({ extraction_data: { source_file_id: "uf-2" } }, null)).toBe("uf-2");
    expect(resolveUploadedFileIdForV3Diagnostics({ extraction_data: { uploaded_file_id: "uf-3" } }, null)).toBe("uf-3");
  });

  it("falls back to the already-loaded debug uploadedFile row when the lease has nothing", () => {
    expect(resolveUploadedFileIdForV3Diagnostics({}, { id: "uf-4" })).toBe("uf-4");
  });

  it("falls back to lease.uploaded_files / lease.uploaded_file (singular/plural join shapes)", () => {
    expect(resolveUploadedFileIdForV3Diagnostics({ uploaded_files: { id: "uf-5" } }, null)).toBe("uf-5");
    expect(resolveUploadedFileIdForV3Diagnostics({ uploaded_file: { id: "uf-6" } }, null)).toBe("uf-6");
    expect(resolveUploadedFileIdForV3Diagnostics({ uploaded_files: [{ id: "uf-7" }] }, null)).toBe("uf-7");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveUploadedFileIdForV3Diagnostics(null, null)).toBeNull();
    expect(resolveUploadedFileIdForV3Diagnostics({}, {})).toBeNull();
  });

  it("ignores blank/whitespace-only ids", () => {
    expect(resolveUploadedFileIdForV3Diagnostics({ source_file_id: "   " }, { id: "uf-8" })).toBe("uf-8");
  });
});

// â”€â”€ buildV3DiagnosticsFilename â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("buildV3DiagnosticsFilename", () => {
  it("builds a filename scoped to the uploaded_file_id", () => {
    expect(buildV3DiagnosticsFilename("uf-123")).toBe("document-intelligence-v3-diagnostics-uf-123.json");
  });

  it("degrades gracefully when uploaded_file_id is missing", () => {
    expect(buildV3DiagnosticsFilename(null)).toBe("document-intelligence-v3-diagnostics-unknown.json");
  });
});

// â”€â”€ summarizeV3Diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("summarizeV3Diagnostics: not-available (Task G.3)", () => {
  it("renders the exact not-available message for a null readiness", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.available).toBe(false);
    expect(summary.notAvailableMessage).toBe("No v3 diagnostic run is available for this upload yet.");
    expect(summary.notAvailableMessage).toBe(DOCUMENT_INTELLIGENCE_V3_NOT_AVAILABLE_MESSAGE);
  });

  it("renders the not-available message when readiness.available === false", () => {
    const summary = summarizeV3Diagnostics({ available: false, run_id: null, readiness: { status: "not_available", reason: "no_completed_run" } });
    expect(summary.available).toBe(false);
    expect(summary.notAvailableMessage).toBe("No v3 diagnostic run is available for this upload yet.");
    expect(summary.readinessStatus).toBe("not_available");
  });
});

function fullAssignmentReadiness(overrides = {}) {
  return {
    diagnostic_only: true,
    available: true,
    run_id: "run-1",
    uploaded_file_id: "uf-1",
    lease_id: null,
    profile: { profile_key: "assignment_amendment", policy_key: "assignment_assumption_amendment", confidence: 0.9, status: "auto_detected" },
    readiness: { status: "needs_review", reason: "blockers_present", note: "Advisory diagnostic only." },
    blockers: [{ field_key: "assignor_name", reason: "missing" }],
    advisories: [{ message: "Original lease required for CAM, expense recovery, and full budget setup.", fields: ["monthly_rent", "cam_amount"] }],
    required_fields: [
      { field_key: "assignor_name", required: true, present: false, value_present: false, source_backed: false, status: "missing", confidence: null, source_claim_ids: [], validation_status: "pending", missing_reason: "not_attempted", validation_drop: null, evidence_sufficiency: "none", evidence_summary: { evidence_rows: 0 }, evidence_warnings: [] },
      { field_key: "landlord_name", required: true, present: true, value_present: true, source_backed: true, status: "source_backed", confidence: 0.9, source_claim_ids: ["c1"], validation_status: "passed", missing_reason: null, validation_drop: null, evidence_sufficiency: "text_only", evidence_summary: { evidence_rows: 1, rows_with_source_text: 1 }, evidence_warnings: ["text_only_no_block_anchor"] },
    ],
    optional_fields: [
      { field_key: "monthly_rent", required: false, present: false, value_present: false, source_backed: false, status: "missing", confidence: null, source_claim_ids: [], validation_status: "pending", missing_reason: "not_attempted", validation_drop: null, evidence_sufficiency: "none", evidence_summary: { evidence_rows: 0 }, evidence_warnings: [] },
    ],
    claim_counts: { total: 2, canonical_field: 1, dynamic: 1 },
    evidence_counts: { total: 1 },
    validation_drop_counts: { total: 0, by_reason: {} },
    source_backed_counts: { required_total: 2, required_source_backed: 1, required_missing: 1, required_needs_review: 0 },
    evidence_sufficiency_counts: {
      fields_with_no_evidence: 2,
      fields_with_text_only_evidence: 1,
      fields_with_block_anchored_evidence: 0,
      fields_with_visual_anchored_evidence: 0,
      fields_with_calculated_evidence: 0,
      fields_with_cross_reference_evidence: 0,
      fields_with_insufficient_evidence: 0,
    },
    profile_ensemble: {
      selected_profile_key: "assignment_assumption_amendment",
      selected_policy_key: "assignment_assumption_amendment",
      confidence: 0.9,
      status: "auto_detected",
      profile_source: "vertex_fact_ledger",
      candidates: [
        { profile_key: "assignment_assumption_amendment", confidence: 0.9, source: "vertex_fact_ledger", signals: { method: "vertex" } },
        { profile_key: "assignment_assumption", confidence: 0.58, source: "deterministic_rules", signals: { assignment: ["assignor"] } },
      ],
      signals: { deterministic: { assignment: ["assignor"] } },
      disagreements: [{ type: "candidate_profile_disagreement", profile_keys: ["assignment_assumption_amendment", "assignment_assumption"] }],
      fallback_reason: null,
    },
    extraction_plan: {
      profile_key: "assignment_assumption_amendment",
      modules_to_run: [
        { module_key: "assignment_terms", reason: "Extract assignment terms.", priority: 1, expected_outputs: ["assumption_scope"], page_hints: [], status: "planned" },
        { module_key: "amendment_terms", reason: "Extract amendment terms.", priority: 2, expected_outputs: ["all_other_terms_remain_same"], page_hints: [], status: "planned" },
      ],
      modules_skipped: [
        { module_key: "cam_rules", reason: "original_lease_required", priority: 90, expected_outputs: [], page_hints: [], status: "skipped" },
      ],
      related_documents_needed: ["original_lease"],
      expected_information_profile: ["assignment terms", "amendment terms"],
      planner_warnings: ["Original lease required for full budget setup."],
      status: "planned",
      diagnostic_only: true,
    },
    modules_to_run_count: 2,
    modules_skipped_count: 1,
    related_documents_needed: ["original_lease"],
    planner_warnings: ["Original lease required for full budget setup."],
    coverage: {
      diagnostic_only: true,
      processing_coverage: { pages_processed: 2, pages_total: 2, page_coverage_percent: 100, layout_available: true, page_markers_present: true, text_block_count: 4, table_count: 1, warning_count: 0 },
      evidence_coverage: { claims_total: 2, claims_with_evidence: 1, claims_without_evidence: 1, evidence_rows_total: 1, evidence_rows_with_source_text: 1, evidence_rows_with_block_ids: 0, evidence_rows_with_polygon: 0, source_backed_field_count: 1, evidence_sufficiency_counts: { fields_with_no_evidence: 2 } },
      expected_information_coverage: { expected_required_fields: 2, found_required_fields: 1, missing_required_fields: 1, expected_optional_fields: 1, found_optional_fields: 0, required_field_coverage_percent: 50, optional_field_coverage_percent: 0 },
      module_coverage: { modules_expected: 3, modules_completed: 1, modules_skipped: 1, modules_failed: 0, modules_not_run: 1, module_coverage_percent: 50 },
      field_coverage: { required_fields: [{ field_key: "assignor_name", status: "missing", importance_level: "critical" }], optional_fields: [] },
      related_document_coverage: { related_documents_needed: ["original_lease"], related_documents_present: [], related_documents_missing: ["original_lease"], missing_related_document_reasons: { original_lease: ["Original lease required for full budget setup."] } },
      validation_coverage: { validation_drops_total: 0, fields_with_validation_drops: [], invalid_markup_values: 0, missing_source_evidence_count: 0, invalid_signature_date_source_count: 0, unsupported_inferred_value_count: 0 },
      overall_coverage: { coverage_level: "partial", coverage_percent: 40, coverage_reason: "required_fields_missing", coverage_warnings: ["required_fields_missing", "missing_related_document:original_lease"] },
    },
    importance_summary: {
      diagnostic_only: true,
      field_counts_by_importance: { critical: 1, high: 1, medium: 1, low: 0, hidden_optional: 0 },
      critical_missing_fields_count: 1,
      high_missing_fields_count: 0,
      important_validation_drops_count: 0,
      high_importance_advisories_count: 1,
      unmapped_claims_count: 1,
      unmapped_high_importance_claims_count: 1,
      important_related_documents_missing: [{ document_type: "original_lease", importance_level: "high" }],
    },
    important_missing_fields: [{ field_key: "assignor_name", importance_level: "critical", importance_score: 91, importance_reasons: ["required_for_profile"] }],
    important_validation_drops: [],
    unmapped_high_importance_claims: [{ claim_id: "c-dynamic", claim_type: "clause:termination", importance_level: "high" }],
    important_related_documents_missing: [{ document_type: "original_lease", importance_level: "high" }],
    related_document_coverage: { related_documents_needed: ["original_lease"], related_documents_present: [], related_documents_missing: ["original_lease"], missing_related_document_reasons: { original_lease: ["Original lease required for full budget setup."] } },
    package_graph: {
      diagnostic_only: true,
      package_id: "pkg-1",
      package_key: "upload:uf-1",
      graph_status: "missing_related_documents",
      documents: [{ document_id: "doc-1", uploaded_file_id: "uf-1", document_profile: "assignment_assumption_amendment", is_primary: true }],
      related_document_requirements: [{ requirement_id: "req-1", required_document_type: "original_lease", status: "missing", reason: "Original lease required." }],
      relationships: [{ relationship_id: "rel-1", relationship_type: "original_lease_for", status: "missing_target" }],
      candidates: [],
    },
    related_document_requirements: [{ requirement_id: "req-1", required_document_type: "original_lease", status: "missing", reason: "Original lease required." }],
    candidate_related_documents: [],
    package_graph_status: "missing_related_documents",
    temporal_supersession: {
      diagnostic_only: true,
      temporal_status: "blocked_missing_related_document",
      document_timeline: [{ uploaded_file_id: "uf-1", sort_date: "2024-03-01", sort_reason: "assignment_effective_date", warnings: [] }],
      effective_periods: [{ field_key: "tenant_name", effective_from: "2024-03-01", status: "candidate" }],
      supersession_candidates: [{ supersession_type: "assigns", field_key: "tenant_name", status: "blocked_missing_related_document" }],
      current_truth_candidates: [{ field_key: "tenant_name", candidate_value: "New Tenant", status: "blocked_missing_related_document" }],
      historical_claims: [{ field_key: "tenant_name", historical_value: "Old Tenant", status: "candidate_historical" }],
      unresolved_temporal_conflicts: [],
      missing_temporal_inputs: ["original_lease_missing"],
      warnings: ["original_lease_missing", "unchanged_terms_rely_on_original_lease"],
    },    coverage_summary: { source_backed_claims: 1, claims_missing_evidence: 1 },
    ...overrides,
  };
}

describe("summarizeV3Diagnostics: assignment advisory (Task G.4)", () => {
  it("surfaces the original-lease advisory message and its fields", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.available).toBe(true);
    expect(summary.profile.policy_key).toBe("assignment_assumption_amendment");
    expect(summary.advisories).toHaveLength(1);
    expect(summary.advisories[0].message).toBe("Original lease required for CAM, expense recovery, and full budget setup.");
    expect(summary.advisories[0].fields).toContain("monthly_rent");
  });
});

describe("summarizeV3Diagnostics: blockers (Task G.5)", () => {
  it("passes through blockers with field_key and reason", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.blockers).toHaveLength(1);
    expect(summary.blockers[0]).toEqual({ field_key: "assignor_name", reason: "missing" });
  });

  it("summarizes required/optional field counts correctly", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.requiredFieldsSummary.total).toBe(2);
    expect(summary.requiredFieldsSummary.sourceBacked).toBe(1);
    expect(summary.requiredFieldsSummary.missing).toBe(1);
    expect(summary.optionalFieldsSummary.total).toBe(1);
    expect(summary.optionalFieldsSummary.missing).toBe(1);
  });
});

describe("summarizeV3Diagnostics: validation drops (Task G.6)", () => {
  it("collects validation_drop entries from both required and optional fields", () => {
    const readiness = fullAssignmentReadiness({
      required_fields: [
        {
          field_key: "landlord_name", required: true, present: true, value_present: true, source_backed: false,
          status: "needs_review", confidence: 0.5, source_claim_ids: [], validation_status: "failed",
          missing_reason: "missing_source_evidence",
          validation_drop: { reason: "invalid_markup_value", bad_value: "<figure>", action: "dropped" },
        },
      ],
      optional_fields: [
        {
          field_key: "tenant_signature_date", required: false, present: true, value_present: true, source_backed: false,
          status: "needs_review", confidence: 0.4, source_claim_ids: [], validation_status: "failed",
          missing_reason: "missing_source_evidence",
          validation_drop: { reason: "invalid_signature_date_source", bad_value: "2018-02-01", action: "flagged" },
        },
      ],
    });
    const summary = summarizeV3Diagnostics(readiness);
    expect(summary.validationDrops).toHaveLength(2);
    const markup = summary.validationDrops.find((d) => d.field_key === "landlord_name");
    expect(markup.reason).toBe("invalid_markup_value");
    expect(markup.bad_value).toBe("<figure>");
    expect(markup.required).toBe(true);
    const sigDate = summary.validationDrops.find((d) => d.field_key === "tenant_signature_date");
    expect(sigDate.reason).toBe("invalid_signature_date_source");
    expect(sigDate.required).toBe(false);
  });

  it("returns an empty list and does not crash when no field carries a validation_drop", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.validationDrops).toEqual([]);
  });
});

describe("summarizeV3Diagnostics: counts and coverage pass through unchanged", () => {
  it("carries claim/evidence/validation-drop/source-backed counts and coverage summary as-is", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.claimCounts).toEqual({ total: 2, canonical_field: 1, dynamic: 1 });
    expect(summary.evidenceCounts).toEqual({ total: 1 });
    expect(summary.sourceBackedCounts.required_total).toBe(2);
    expect(summary.coverageSummary).toEqual({ source_backed_claims: 1, claims_missing_evidence: 1 });
    expect(summary.diagnosticOnly).toBe(true);
    expect(summary.runId).toBe("run-1");
  });
});
describe("summarizeV3Diagnostics: Phase 9 profile ensemble and extraction plan", () => {
  it("passes through profile ensemble candidates/signals and planner counts", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.profileEnsemble.selectedPolicyKey).toBe("assignment_assumption_amendment");
    expect(summary.profileEnsemble.source).toBe("vertex_fact_ledger");
    expect(summary.profileEnsemble.candidates).toHaveLength(2);
    expect(summary.profileEnsemble.disagreements).toHaveLength(1);
    expect(summary.extractionPlan.profileKey).toBe("assignment_assumption_amendment");
    expect(summary.extractionPlan.modulesToRun.map((module) => module.module_key)).toContain("amendment_terms");
    expect(summary.extractionPlan.modulesSkipped.map((module) => module.module_key)).toContain("cam_rules");
    expect(summary.modulesToRunCount).toBe(2);
    expect(summary.modulesSkippedCount).toBe(1);
    expect(summary.relatedDocumentsNeeded).toEqual(["original_lease"]);
    expect(summary.plannerWarnings[0]).toMatch(/Original lease required/);
  });
});
describe("summarizeV3Diagnostics: Phase 8 evidence sufficiency diagnostics", () => {
  it("passes through run-level evidence sufficiency counts and per-field warnings", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.evidenceSufficiencyCounts.fields_with_no_evidence).toBe(2);
    expect(summary.evidenceSufficiencyCounts.fields_with_text_only_evidence).toBe(1);
    expect(summary.evidenceSufficiencySummary.find((row) => row.key === "fields_with_text_only_evidence")).toEqual({
      key: "fields_with_text_only_evidence",
      label: "Text only",
      count: 1,
    });
    const landlord = summary.requiredFieldsSummary.fields.find((field) => field.field_key === "landlord_name");
    expect(landlord.evidence_sufficiency).toBe("text_only");
    expect(landlord.evidence_warnings).toContain("text_only_no_block_anchor");
  });

  it("falls back to coverage_summary counts for older readiness payload shapes", () => {
    const readiness = fullAssignmentReadiness({
      evidence_sufficiency_counts: undefined,
      coverage_summary: {
        source_backed_claims: 1,
        claims_missing_evidence: 1,
        fields_with_no_evidence: 4,
        fields_with_visual_anchored_evidence: 2,
      },
    });
    const summary = summarizeV3Diagnostics(readiness);
    expect(summary.evidenceSufficiencyCounts.fields_with_no_evidence).toBe(4);
    expect(summary.evidenceSufficiencyCounts.fields_with_visual_anchored_evidence).toBe(2);
  });

  it("formats all sufficiency buckets for the admin-only debug panel", () => {
    expect(summarizeEvidenceSufficiencyCounts({ fields_with_calculated_evidence: 3 })).toEqual([
      { key: "fields_with_no_evidence", label: "No evidence", count: 0 },
      { key: "fields_with_text_only_evidence", label: "Text only", count: 0 },
      { key: "fields_with_block_anchored_evidence", label: "Block anchored", count: 0 },
      { key: "fields_with_visual_anchored_evidence", label: "Visual anchored", count: 0 },
      { key: "fields_with_calculated_evidence", label: "Calculated", count: 3 },
      { key: "fields_with_cross_reference_evidence", label: "Cross reference", count: 0 },
      { key: "fields_with_insufficient_evidence", label: "Insufficient", count: 0 },
    ]);
  });
});


// â”€â”€ Phase 5: canonical layout summary (Task F) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("summarizeLayoutSummary", () => {
  it("returns null when no layout_summary is present (older runs / docling_raw unavailable at side-write time)", () => {
    expect(summarizeLayoutSummary(undefined)).toBeNull();
    expect(summarizeLayoutSummary(null)).toBeNull();
    expect(summarizeLayoutSummary({})).toBeNull();
  });

  it("normalizes a populated layout_summary into the display shape", () => {
    const summary = summarizeLayoutSummary({
      layout_provider: "azure_document_intelligence",
      api_version: "2024-11-30",
      page_count: 3,
      full_text_chars: 1200,
      pages_with_text: 3,
      text_block_count: 5,
      table_count: 1,
      figure_count: 0,
      signature_region_count: 0,
      selection_mark_count: 0,
      page_markers_present: true,
      page_mapping_coverage: 1,
      warnings: [],
    });
    expect(summary).toEqual({
      layoutProvider: "azure_document_intelligence",
      apiVersion: "2024-11-30",
      pageCount: 3,
      fullTextChars: 1200,
      pagesWithText: 3,
      textBlockCount: 5,
      tableCount: 1,
      figureCount: 0,
      signatureRegionCount: 0,
      selectionMarkCount: 0,
      pageMarkersPresent: true,
      pageMappingCoverage: 1,
      warnings: [],
    });
  });

  it("carries warnings through (e.g. empty-page-text) without crashing", () => {
    const summary = summarizeLayoutSummary({ warnings: ["empty_page_text:page_2"], page_count: 2 });
    expect(summary.warnings).toEqual(["empty_page_text:page_2"]);
  });
});

describe("summarizeV3Diagnostics: threads layout_summary through as layoutSummary", () => {
  it("is null when the readiness response carries no layout_summary", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness({ layout_summary: {} }));
    expect(summary.layoutSummary).toBeNull();
  });

  it("is populated when the readiness response carries a real layout_summary", () => {
    const summary = summarizeV3Diagnostics(
      fullAssignmentReadiness({ layout_summary: { layout_provider: "azure_document_intelligence", page_count: 3, warnings: [] } }),
    );
    expect(summary.layoutSummary).not.toBeNull();
    expect(summary.layoutSummary.layoutProvider).toBe("azure_document_intelligence");
    expect(summary.layoutSummary.pageCount).toBe(3);
  });

  it("is null for the not-available shape", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.layoutSummary).toBeNull();
  });
});

// â”€â”€ Phase 7: evidence anchor diagnostics (Task F) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("summarizeEvidenceAnchorDiagnostics", () => {
  it("returns null when coverage_summary carries none of the Phase 7 fields (older/legacy runs)", () => {
    expect(summarizeEvidenceAnchorDiagnostics(undefined)).toBeNull();
    expect(summarizeEvidenceAnchorDiagnostics(null)).toBeNull();
    expect(summarizeEvidenceAnchorDiagnostics({})).toBeNull();
    expect(summarizeEvidenceAnchorDiagnostics({ source_backed_claims: 2, claims_missing_evidence: 0 })).toBeNull();
  });

  it("normalizes a populated coverage_summary into the display shape", () => {
    const summary = summarizeEvidenceAnchorDiagnostics({
      source_backed_claims: 2,
      claims_missing_evidence: 0,
      evidence_rows_with_block_ids: 1,
      evidence_rows_with_polygon: 1,
      evidence_rows_with_source_text: 2,
      evidence_rows_without_source_text: 0,
      evidence_anchor_source: "canonical_layout",
    });
    expect(summary).toEqual({
      withBlockIds: 1,
      withPolygon: 1,
      withSourceText: 2,
      withoutSourceText: 0,
      anchorSource: "canonical_layout",
    });
  });

  it("defaults anchorSource to 'unavailable' when present but not one of the counts", () => {
    const summary = summarizeEvidenceAnchorDiagnostics({ evidence_rows_with_block_ids: 0 });
    expect(summary.anchorSource).toBe("unavailable");
  });
});

describe("summarizeV3Diagnostics: threads evidenceAnchorDiagnostics through", () => {
  it("is null when the readiness response carries no Phase 7 coverage fields", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.evidenceAnchorDiagnostics).toBeNull();
  });

  it("is populated when coverage_summary carries the Phase 7 evidence-anchor fields", () => {
    const summary = summarizeV3Diagnostics(
      fullAssignmentReadiness({
        coverage_summary: {
          source_backed_claims: 1,
          claims_missing_evidence: 1,
          evidence_rows_with_block_ids: 1,
          evidence_rows_with_polygon: 1,
          evidence_rows_with_source_text: 2,
          evidence_rows_without_source_text: 0,
          evidence_anchor_source: "canonical_layout",
        },
      }),
    );
    expect(summary.evidenceAnchorDiagnostics).not.toBeNull();
    expect(summary.evidenceAnchorDiagnostics.withBlockIds).toBe(1);
    expect(summary.evidenceAnchorDiagnostics.anchorSource).toBe("canonical_layout");
  });

  it("is null for the not-available shape", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.evidenceAnchorDiagnostics).toBeNull();
  });
});


describe("summarizeV3Diagnostics: Phase 10 coverage and importance diagnostics", () => {
  it("passes through coverage buckets and importance diagnostics", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.coverage.processing.pages_processed).toBe(2);
    expect(summary.coverage.evidence.claims_total).toBe(2);
    expect(summary.coverage.expectedInformation.expected_required_fields).toBe(2);
    expect(summary.coverage.module.modules_skipped).toBe(1);
    expect(summary.coverage.relatedDocument.related_documents_missing).toEqual(["original_lease"]);
    expect(summary.coverage.validation.validation_drops_total).toBe(0);
    expect(summary.coverage.overall.coverage_level).toBe("partial");
    expect(summary.importance.summary.critical_missing_fields_count).toBe(1);
    expect(summary.importantMissingFields[0].field_key).toBe("assignor_name");
    expect(summary.unmappedHighImportanceClaims[0].claim_type).toBe("clause:termination");
    expect(summary.importantRelatedDocumentsMissing[0].document_type).toBe("original_lease");
  });

  it("returns null coverage/importance for the not-available shape", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.coverage).toBeNull();
    expect(summary.importance).toBeNull();
    expect(summary.importantMissingFields).toEqual([]);
  });
});
describe("summarizeV3Diagnostics: Phase 11 package graph diagnostics", () => {
  it("passes through document package graph, requirements, relationships, and candidates", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.packageGraph.packageId).toBe("pkg-1");
    expect(summary.packageGraph.packageKey).toBe("upload:uf-1");
    expect(summary.packageGraphStatus).toBe("missing_related_documents");
    expect(summary.packageGraph.documents).toHaveLength(1);
    expect(summary.packageGraph.relationships[0].status).toBe("missing_target");
    expect(summary.relatedDocumentRequirements[0].required_document_type).toBe("original_lease");
    expect(summary.candidateRelatedDocuments).toEqual([]);
  });

  it("shows candidate_found without treating the document as present", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness({
      package_graph_status: "candidates_found",
      package_graph: {
        diagnostic_only: true,
        package_id: "pkg-2",
        package_key: "lease:lease-1",
        graph_status: "candidates_found",
        documents: [],
        relationships: [{ relationship_id: "rel-2", relationship_type: "original_lease_for", status: "needs_review" }],
        related_document_requirements: [{ requirement_id: "req-2", required_document_type: "original_lease", status: "candidate_found" }],
        candidates: [{ candidate_document_id: "doc-base", status: "candidate_found", matched_signals: ["same_lease_id"] }],
      },
      related_document_requirements: [{ requirement_id: "req-2", required_document_type: "original_lease", status: "candidate_found" }],
      candidate_related_documents: [{ candidate_document_id: "doc-base", status: "candidate_found", matched_signals: ["same_lease_id"] }],
    }));
    expect(summary.packageGraphStatus).toBe("candidates_found");
    expect(summary.relatedDocumentRequirements[0].status).toBe("candidate_found");
    expect(summary.candidateRelatedDocuments[0].status).toBe("candidate_found");
    expect(summary.packageGraph.relationships[0].status).toBe("needs_review");
  });
});
describe("summarizeV3Diagnostics: Phase 12 temporal supersession diagnostics", () => {
  it("passes through temporal timeline, supersession, current truth, conflicts, and warnings", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness());
    expect(summary.temporalSupersession.temporalStatus).toBe("blocked_missing_related_document");
    expect(summary.temporalSupersession.documentTimeline[0].sort_reason).toBe("assignment_effective_date");
    expect(summary.temporalSupersession.effectivePeriods[0].field_key).toBe("tenant_name");
    expect(summary.temporalSupersession.supersessionCandidates[0].supersession_type).toBe("assigns");
    expect(summary.temporalSupersession.currentTruthCandidates[0].status).toBe("blocked_missing_related_document");
    expect(summary.temporalSupersession.missingTemporalInputs).toContain("original_lease_missing");
    expect(summary.temporalSupersession.warnings).toContain("unchanged_terms_rely_on_original_lease");
  });

  it("returns null temporal diagnostics for the not-available shape", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.temporalSupersession).toBeNull();
  });
});
describe("summarizeV3Diagnostics: Phase 13 approval advisory simulation", () => {
  it("passes through approval advisory decision buckets", () => {
    const summary = summarizeV3Diagnostics(fullAssignmentReadiness({
      approval_advisory: {
        diagnostic_only: true,
        advisory_status: "advisory_blocked",
        advisory_reason: "future v3 gate would block approval",
        would_block_approval: true,
        would_allow_approval: false,
        profile_key: "assignment",
        policy_key: "assignment_assumption",
        blockers: [{ blocker_type: "missing_critical_field", severity: "blocking_if_enforced", field_key: "assignee_name", recommended_action: "Review field" }],
        warnings: ["layout_unavailable"],
        advisories: [],
        missing_required_fields: [{ field_key: "assignee_name" }],
        missing_critical_fields: [{ field_key: "assignee_name" }],
        evidence_issues: [{ blocker_type: "missing_source_evidence", field_key: "assignee_name" }],
        validation_issues: [{ validation_drop_reason: "invalid_markup_value" }],
        coverage_issues: [{ reason: "coverage_level:minimal" }],
        related_document_issues: [{ reason: "missing_related_document:original_lease" }],
        temporal_issues: [{ reason: "blocked_missing_related_document" }],
        approval_readiness_summary: {
          blocker_counts_by_severity: { blocking_if_enforced: 1, needs_review: 2, advisory: 0, informational: 0 },
        },
        future_gate_inputs: { readiness_status: "needs_review" },
      },
    }));
    expect(summary.approvalAdvisory.advisoryStatus).toBe("advisory_blocked");
    expect(summary.approvalAdvisory.wouldBlockApproval).toBe(true);
    expect(summary.approvalAdvisory.blockerCountsBySeverity.blocking_if_enforced).toBe(1);
    expect(summary.approvalAdvisory.missingCriticalFields[0].field_key).toBe("assignee_name");
    expect(summary.approvalAdvisory.relatedDocumentIssues[0].reason).toBe("missing_related_document:original_lease");
    expect(summary.approvalAdvisory.futureGateInputs.readiness_status).toBe("needs_review");
  });

  it("returns null approval advisory diagnostics for the not-available shape", () => {
    const summary = summarizeV3Diagnostics(null);
    expect(summary.approvalAdvisory).toBeNull();
  });
});
describe("summarizeAdvisoryAudit: Phase 14 advisory audit comparison", () => {
  it("normalizes advisory audit comparison fields for Extraction Debug", () => {
    const summary = summarizeAdvisoryAudit({
      diagnostic_only: true,
      audit_id: "audit-1",
      run_id: "run-1",
      uploaded_file_id: "uf-1",
      lease_id: "lease-1",
      generated_at: "2026-07-14T00:00:00.000Z",
      v3_advisory: { advisory_status: "advisory_blocked" },
      current_review_snapshot: { current_status: "allows_approval" },
      comparison: {
        v3_status: "advisory_blocked",
        current_status: "allows_approval",
        agreement_level: "differs_v3_stricter",
        false_positive_risks: [],
        false_negative_risks: ["current_approval_may_miss_v3_blockers"],
        missing_inputs: [],
        notes: ["inferred"],
      },
      discrepancies: [{ type: "current_path_may_be_too_permissive", severity: "high" }],
      recommendations: ["Review v3 blockers"],
      audit_status: "discrepancies_found",
    });

    expect(summary.auditId).toBe("audit-1");
    expect(summary.v3Status).toBe("advisory_blocked");
    expect(summary.currentStatus).toBe("allows_approval");
    expect(summary.agreementLevel).toBe("differs_v3_stricter");
    expect(summary.discrepancyCount).toBe(1);
    expect(summary.falseNegativeRisks).toContain("current_approval_may_miss_v3_blockers");
    expect(summary.raw.audit_id).toBe("audit-1");
  });

  it("returns null when no audit payload is available", () => {
    expect(summarizeAdvisoryAudit(null)).toBeNull();
  });

  it("builds advisory audit filenames scoped to uploaded_file_id", () => {
    expect(buildV3AdvisoryAuditFilename("uf-123")).toBe("document-intelligence-v3-advisory-audit-uf-123.json");
    expect(buildV3AdvisoryAuditFilename(null)).toBe("document-intelligence-v3-advisory-audit-unknown.json");
  });
});
describe("summarizeAdvisoryAuditBatch: Phase 15 batch audit report", () => {
  it("normalizes aggregate counts and result rows for Extraction Debug", () => {
    const summary = summarizeAdvisoryAuditBatch({
      diagnostic_only: true,
      total: 1,
      generated_at: "2026-07-15T00:00:00.000Z",
      agreement_counts: { agrees: 1, differs_v3_stricter: 0 },
      discrepancy_counts: { current_path_may_be_too_permissive: 0 },
      advisory_status_counts: { advisory_ready: 1 },
      current_status_counts: { allows_approval: 1 },
      risk_summary: { not_enough_data: 0 },
      results: [{ uploaded_file_id: "uf-1", agreement_level: "agrees", discrepancy_count: 0 }],
    });

    expect(summary.total).toBe(1);
    expect(summary.agreementCounts.agrees).toBe(1);
    expect(summary.advisoryStatusCounts.advisory_ready).toBe(1);
    expect(summary.currentStatusCounts.allows_approval).toBe(1);
    expect(summary.results[0].uploaded_file_id).toBe("uf-1");
    expect(summary.raw.total).toBe(1);
  });

  it("returns null when no batch payload is available", () => {
    expect(summarizeAdvisoryAuditBatch(null)).toBeNull();
  });

  it("builds batch advisory audit filenames scoped to uploaded_file_id", () => {
    expect(buildV3AdvisoryAuditBatchFilename("uf-123")).toBe("document-intelligence-v3-advisory-audit-batch-uf-123.json");
    expect(buildV3AdvisoryAuditBatchFilename(null)).toBe("document-intelligence-v3-advisory-audit-batch-unknown.json");
  });
});


