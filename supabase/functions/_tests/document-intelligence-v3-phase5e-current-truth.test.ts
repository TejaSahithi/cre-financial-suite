// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildPackageKey } from "../_shared/extraction/document-intelligence-v3/package-graph.ts";
import { buildTemporalSupersessionDiagnostics } from "../_shared/extraction/document-intelligence-v3/temporal-supersession.ts";
import { buildAbstractSnapshot } from "../_shared/lease-approval-workflow.ts";

function projection(field_key: string, value: unknown, uploaded_file_id: string, document_id: string, id = field_key) {
  return {
    field_key,
    value,
    normalized_value: value,
    uploaded_file_id,
    document_id,
    run_id: `run-${uploaded_file_id}`,
    source_claim_ids: [`claim-${id}`],
    confidence: 0.9,
  };
}

function phase5ePackageGraph(overrides = {}) {
  return {
    package_id: "pkg-phase5e",
    package_key: "lease:phase5e-lease",
    diagnostic_only: true,
    documents: [
      { document_id: "doc-base", uploaded_file_id: "uf-base", run_id: "run-uf-base", document_profile: "base_lease" },
      { document_id: "doc-rent", uploaded_file_id: "uf-rent", run_id: "run-uf-rent", document_profile: "lease_amendment" },
      { document_id: "doc-assignment", uploaded_file_id: "uf-assignment", run_id: "run-uf-assignment", document_profile: "assignment_assumption" },
      { document_id: "doc-cam", uploaded_file_id: "uf-cam", run_id: "run-uf-cam", document_profile: "lease_amendment" },
      { document_id: "doc-renewal", uploaded_file_id: "uf-renewal", run_id: "run-uf-renewal", document_profile: "renewal_amendment" },
      { document_id: "doc-exhibit", uploaded_file_id: "uf-exhibit", run_id: "run-uf-exhibit", document_profile: "exhibit" },
    ],
    relationships: [
      { relationship_type: "original_lease_for", status: "confirmed" },
      { relationship_type: "amends", status: "confirmed" },
      { relationship_type: "assigns", status: "confirmed" },
      { relationship_type: "references", status: "confirmed" },
    ],
    related_document_requirements: [
      { required_document_type: "original_lease", status: "linked" },
      { required_document_type: "parent_document", status: "linked" },
    ],
    candidates: [],
    ...overrides,
  };
}

Deno.test("Phase 5E current truth: deterministic package yields advisory candidates without mutating original facts", () => {
  const projections = [
    projection("landlord_name", "Markets at Choto, LLC", "uf-base", "doc-base"),
    projection("tenant_name", "Cress Family Restaurants, LLC", "uf-base", "doc-base", "base-tenant"),
    projection("commencement_date", "2019-03-01", "uf-base", "doc-base"),
    projection("expiration_date", "2029-02-28", "uf-base", "doc-base", "base-expiration"),
    projection("monthly_rent", 20000, "uf-base", "doc-base", "base-rent"),
    projection("cam_share", "5.25%", "uf-base", "doc-base"),
    projection("renewal_option", "5 years", "uf-base", "doc-base"),
    projection("premises_description", "Base lease premises description.", "uf-base", "doc-base", "base-premises"),

    projection("amendment_date", "2024-01-01", "uf-rent", "doc-rent"),
    projection("amended_base_rent", 23500, "uf-rent", "doc-rent", "rent-amendment"),
    projection("all_other_terms_remain_same", true, "uf-rent", "doc-rent"),

    projection("assignment_effective_date", "2025-06-01", "uf-assignment", "doc-assignment"),
    projection("assignor_name", "Cress Family Restaurants, LLC", "uf-assignment", "doc-assignment"),
    projection("assignee_name", "New Operating Tenant, LLC", "uf-assignment", "doc-assignment", "assignee"),

    projection("effective_date", "2026-01-01", "uf-cam", "doc-cam"),
    projection("cam_cap", "5%", "uf-cam", "doc-cam"),
    projection("reconciliation_deadline", "90 days after year-end", "uf-cam", "doc-cam"),

    projection("renewal_effective_date", "2029-03-01", "uf-renewal", "doc-renewal"),
    projection("renewal_expiration_date", "2034-02-28", "uf-renewal", "doc-renewal", "renewal-expiration"),

    projection("premises_description", "Exhibit A detailed premises description.", "uf-exhibit", "doc-exhibit", "exhibit-premises"),
  ];
  const before = JSON.stringify(projections);

  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: phase5ePackageGraph(),
    projections,
    profileKey: "lease_amendment",
  });

  assertEquals(diagnostic.diagnostic_only, true);
  assertEquals(JSON.stringify(projections), before);
  assert(diagnostic.warnings.includes("unchanged_terms_rely_on_original_lease"));

  const tenantCandidate = diagnostic.current_truth_candidates.find((row) =>
    row.field_key === "tenant_name" && row.reason === "supersession_candidate:assigns"
  );
  assertEquals(tenantCandidate?.candidate_value, "New Operating Tenant, LLC");
  assertEquals(tenantCandidate?.source_document_id, "doc-assignment");
  assertEquals(tenantCandidate?.effective_from, "2025-06-01");

  const rentCandidate = diagnostic.current_truth_candidates.find((row) =>
    row.field_key === "monthly_rent" && row.reason === "supersession_candidate:replaces"
  );
  assertEquals(rentCandidate?.candidate_value, 23500);
  assertEquals(rentCandidate?.source_document_id, "doc-rent");

  const expirationCandidate = diagnostic.current_truth_candidates.find((row) =>
    row.field_key === "expiration_date" && row.reason === "supersession_candidate:renews"
  );
  assertEquals(expirationCandidate?.candidate_value, "2034-02-28");
  assertEquals(expirationCandidate?.source_document_id, "doc-renewal");

  const camShareCandidate = diagnostic.current_truth_candidates.find((row) => row.field_key === "cam_share");
  assertEquals(camShareCandidate?.candidate_value, "5.25%");
  assertEquals(camShareCandidate?.status, "candidate_current");

  const camCapCandidate = diagnostic.current_truth_candidates.find((row) => row.field_key === "cam_cap");
  assertEquals(camCapCandidate?.candidate_value, "5%");
  assertEquals(camCapCandidate?.source_document_id, "doc-cam");

  const premisesCandidate = diagnostic.current_truth_candidates.find((row) => row.field_key === "premises_description");
  assertEquals(premisesCandidate?.status, "conflict");
  assertEquals(premisesCandidate?.blockers, ["manual_temporal_review_required"]);
});

Deno.test("Phase 5E conflict behavior: unsupported overlapping economics need review instead of newest-upload authority", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: phase5ePackageGraph({
      documents: [
        { document_id: "doc-base", uploaded_file_id: "uf-base", run_id: "run-uf-base", document_profile: "base_lease" },
        { document_id: "doc-cam", uploaded_file_id: "uf-cam", run_id: "run-uf-cam", document_profile: "lease_amendment" },
      ],
    }),
    projections: [
      projection("effective_date", "2019-03-01", "uf-base", "doc-base"),
      projection("cam_share", "5.25%", "uf-base", "doc-base", "base-cam-share"),
      projection("effective_date", "2026-01-01", "uf-cam", "doc-cam"),
      projection("cam_share", "6.00%", "uf-cam", "doc-cam", "cam-amendment-share"),
    ],
    profileKey: "lease_amendment",
  });

  const camShare = diagnostic.current_truth_candidates.find((row) => row.field_key === "cam_share");
  assertEquals(camShare?.status, "conflict");
  assertEquals(camShare?.reason, "multiple_values_without_temporal_resolution");
  assertEquals(diagnostic.temporal_status, "conflicts_detected");
});

Deno.test("Phase 5E package graph: documents without a shared lease id remain separate upload packages", () => {
  assertEquals(buildPackageKey({ uploadedFileId: "uf-base", profileKey: "base_lease" }), "upload:uf-base");
  assertEquals(buildPackageKey({ uploadedFileId: "uf-amendment", profileKey: "lease_amendment" }), "upload:uf-amendment");
  assertEquals(buildPackageKey({ leaseId: "lease-1", uploadedFileId: "uf-amendment", profileKey: "lease_amendment" }), "lease:lease-1");
});

Deno.test("Phase 5E approval snapshot: reviewer value wins, but package-current metadata is not synthesized today", () => {
  const snapshot = buildAbstractSnapshot({
    lease: {
      source_file_id: "uf-rent",
      extraction_data: {
        source_file_id: "uf-rent",
        source_file_name: "phase5e-rent-amendment.pdf",
        document_subtype: "lease_amendment",
        fields: {
          monthly_rent: {
            value: 23500,
            source_page: 2,
            source_text: "Sanitized rent amendment evidence.",
          },
        },
      },
    },
    fieldReviews: {
      monthly_rent: {
        status: "edited",
        value: 23600,
        source_page: 2,
        source_text: "Reviewer-approved sanitized rent amendment evidence.",
        reviewer: "phase5e-reviewer@example.test",
      },
    },
    version: 2,
    approvedBy: "phase5e-reviewer@example.test",
    approvedAt: "2026-07-17T12:00:00.000Z",
  });

  assertEquals(snapshot.fields.monthly_rent.value, 23600);
  assertEquals(snapshot.approved.monthly_rent.review_status, "edited");
  assertEquals(snapshot.source_document.uploaded_file_id, "uf-rent");
  assertEquals("package_id" in snapshot, false);
  assertEquals("effective_date" in snapshot.fields.monthly_rent, false);
  assertEquals("superseded_value" in snapshot.fields.monthly_rent, false);
});
