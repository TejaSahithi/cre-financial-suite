// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildTemporalSupersessionDiagnostics } from "../_shared/extraction/document-intelligence-v3/temporal-supersession.ts";

function projection(field_key: string, value: unknown, uploaded_file_id = "uf-1", id = field_key) {
  return {
    field_key,
    value,
    normalized_value: value,
    uploaded_file_id,
    run_id: `run-${uploaded_file_id}`,
    source_claim_ids: [`claim-${id}`],
    confidence: 0.9,
  };
}

function graph(overrides = {}) {
  return {
    package_id: "pkg-1",
    package_key: "lease:lease-1",
    diagnostic_only: true,
    documents: [
      { document_id: "doc-base", uploaded_file_id: "uf-base", run_id: "run-uf-base", document_profile: "base_lease" },
      { document_id: "doc-1", uploaded_file_id: "uf-1", run_id: "run-uf-1", document_profile: "assignment_assumption" },
    ],
    relationships: [],
    related_document_requirements: [],
    candidates: [],
    ...overrides,
  };
}

Deno.test("temporal/supersession: document timeline orders by effective date", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [
      projection("effective_date", "2025-02-01", "uf-1"),
      projection("effective_date", "2020-01-01", "uf-base"),
    ],
    profileKey: "assignment_assumption",
  });
  assertEquals(diagnostic.document_timeline.map((item) => item.uploaded_file_id), ["uf-base", "uf-1"]);
  assertEquals(diagnostic.document_timeline[0].sort_reason, "effective_date");
});

Deno.test("temporal/supersession: missing effective date creates warnings, not a crash", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph({ documents: [{ document_id: "doc-1", uploaded_file_id: "uf-1", run_id: "run-uf-1" }] }),
    projections: [],
    profileKey: "base_lease",
  });
  assert(diagnostic.warnings.includes("missing_effective_date"));
  assert(diagnostic.missing_temporal_inputs.includes("missing_effective_date"));
});

Deno.test("temporal/supersession: assignment_effective_date creates assignment supersession candidate", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [
      projection("assignment_effective_date", "2024-03-01"),
      projection("assignor_name", "Old Tenant"),
      projection("assignee_name", "New Tenant"),
    ],
    profileKey: "assignment_assumption",
  });
  assertEquals(diagnostic.supersession_candidates[0].supersession_type, "assigns");
  assertEquals(diagnostic.supersession_candidates[0].field_key, "tenant_name");
  assertEquals(diagnostic.supersession_candidates[0].effective_from, "2024-03-01");
});

Deno.test("temporal/supersession: amended_expiration_date creates expiration supersession candidate", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [
      projection("amendment_date", "2024-04-01"),
      projection("expiration_date", "2026-12-31"),
      projection("amended_expiration_date", "2028-12-31"),
    ],
    profileKey: "lease_amendment",
  });
  const candidate = diagnostic.supersession_candidates.find((row) => row.field_key === "expiration_date");
  assertEquals(candidate.supersession_type, "extends");
  assertEquals(candidate.new_value, "2028-12-31");
});

Deno.test("temporal/supersession: termination_effective_date creates termination candidate", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [projection("termination_effective_date", "2024-09-30")],
    profileKey: "termination_agreement",
  });
  const candidate = diagnostic.supersession_candidates.find((row) => row.supersession_type === "terminates");
  assertEquals(candidate.field_key, "lease_status");
  assertEquals(candidate.new_value, "terminated");
});

Deno.test("temporal/supersession: all_other_terms_remain_same creates unchanged-terms warning", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [projection("all_other_terms_remain_same", true)],
    profileKey: "lease_amendment",
  });
  assert(diagnostic.warnings.includes("unchanged_terms_rely_on_original_lease"));
});

Deno.test("temporal/supersession: missing original lease blocks dependent supersession", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph({
      related_document_requirements: [{ required_document_type: "original_lease", status: "missing" }],
    }),
    projections: [
      projection("assignment_effective_date", "2024-03-01"),
      projection("assignor_name", "Old Tenant"),
      projection("assignee_name", "New Tenant"),
    ],
    profileKey: "assignment_assumption",
  });
  assertEquals(diagnostic.supersession_candidates[0].status, "blocked_missing_related_document");
  assert(diagnostic.warnings.includes("original_lease_missing"));
});

Deno.test("temporal/supersession: current truth candidates are diagnostic only and do not mutate projections", () => {
  const rows = [projection("monthly_rent", 5000), projection("amended_base_rent", 6000)];
  const before = JSON.stringify(rows);
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: rows,
    profileKey: "lease_amendment",
  });
  assertEquals(JSON.stringify(rows), before);
  assert(diagnostic.current_truth_candidates.some((row) => row.field_key === "monthly_rent"));
});

Deno.test("temporal/supersession: unknown_cre_document does not produce base lease supersession assumptions", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph(),
    projections: [
      projection("assignment_effective_date", "2024-03-01"),
      projection("assignor_name", "Old Tenant"),
      projection("assignee_name", "New Tenant"),
    ],
    profileKey: "unknown_cre_document",
  });
  assertEquals(diagnostic.supersession_candidates, []);
});

Deno.test("temporal/supersession: package graph relationships can confirm diagnostic candidates", () => {
  const diagnostic = buildTemporalSupersessionDiagnostics({
    packageGraph: graph({
      relationships: [{ relationship_type: "original_lease_for", status: "confirmed" }],
      related_document_requirements: [{ required_document_type: "original_lease", status: "linked" }],
    }),
    projections: [
      projection("amendment_date", "2024-04-01"),
      projection("amended_expiration_date", "2028-12-31"),
    ],
    profileKey: "lease_amendment",
  });
  assertEquals(diagnostic.supersession_candidates[0].status, "confirmed_by_relationship");
});
