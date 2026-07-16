// @ts-nocheck
// Phase 1 unit tests for the Document Intelligence v3 scaffold
// (supabase/functions/_shared/extraction/document-intelligence-v3/).
// Pure-function tests only -- no DB, no network, no live extraction.
// Run: deno test --allow-env --allow-read --no-lock document-intelligence-v3.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildEmptyDocumentIntelligenceV3Contract,
  buildDocumentIntelligenceV3VersionMetadata,
  validateDocumentIntelligenceV3ContractShape,
  validateDocumentIntelligenceV3Claim,
  validateDocumentIntelligenceV3Evidence,
  DOCUMENT_INTELLIGENCE_V3_TOP_LEVEL_SECTIONS,
  DOCUMENT_INTELLIGENCE_V3_CONTRACT_VERSION,
} from "../_shared/extraction/document-intelligence-v3/contract.ts";
import { buildDocumentIntelligenceV3Skeleton } from "../_shared/extraction/document-intelligence-v3/adapter.ts";
import { isDocumentIntelligenceV3Enabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import type { DocumentIntelligenceV3Claim, DocumentIntelligenceV3Evidence } from "../_shared/extraction/document-intelligence-v3/types.ts";

// ── Task A/B: contract shape + version metadata ─────────────────────────────

Deno.test("buildEmptyDocumentIntelligenceV3Contract: contains every required top-level section (Task A)", () => {
  const contract = buildEmptyDocumentIntelligenceV3Contract();
  const result = validateDocumentIntelligenceV3ContractShape(contract);
  assert(result.valid, `expected a valid skeleton, got errors: ${result.errors.join(", ")}`);
  assertEquals(DOCUMENT_INTELLIGENCE_V3_TOP_LEVEL_SECTIONS.length, 23);
  for (const key of DOCUMENT_INTELLIGENCE_V3_TOP_LEVEL_SECTIONS) {
    assert(key in contract, `contract is missing section "${key}"`);
  }
});

Deno.test("validateDocumentIntelligenceV3ContractShape: flags a contract missing a required section", () => {
  const contract = buildEmptyDocumentIntelligenceV3Contract();
  delete (contract as any).claims;
  delete (contract as any).readiness;
  const result = validateDocumentIntelligenceV3ContractShape(contract);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.includes("claims")));
  assert(result.errors.some((e) => e.includes("readiness")));
});

Deno.test("buildEmptyDocumentIntelligenceV3Contract: every array section starts empty, every list-of-record section starts at its declared default", () => {
  const contract = buildEmptyDocumentIntelligenceV3Contract();
  assertEquals(contract.contract_version, DOCUMENT_INTELLIGENCE_V3_CONTRACT_VERSION);
  assertEquals(contract.entities, []);
  assertEquals(contract.claims, []);
  assertEquals(contract.canonical_fields, []);
  assertEquals(contract.clauses, []);
  assertEquals(contract.validation_drops, []);
  assertEquals(contract.unmapped_claims, []);
  assertEquals(contract.profile.status, "unclassified");
  assertEquals(contract.readiness.approval_readiness, "not_started");
  assertEquals(contract.review.status, "not_started");
  assertEquals(contract.coverage.diagnostic_only, true);
  assertEquals(contract.coverage.overall_coverage.coverage_level, "unavailable");
  assertEquals(contract.importance.diagnostic_only, true);
  assertEquals(contract.importance.field_counts_by_importance.critical, 0);
});

Deno.test("buildDocumentIntelligenceV3VersionMetadata: all 11 version fields present, default to null, overridable", () => {
  const metadata = buildDocumentIntelligenceV3VersionMetadata();
  const expectedKeys = [
    "pipeline_version", "layout_provider", "layout_api_version", "extraction_provider",
    "extraction_model", "prompt_bundle_version", "ontology_version", "validation_rules_version",
    "profile_policy_version", "ui_projection_version", "content_hash",
  ];
  for (const key of expectedKeys) {
    assert(key in metadata, `version metadata missing "${key}"`);
    assertEquals((metadata as any)[key], null);
  }
  const overridden = buildDocumentIntelligenceV3VersionMetadata({ layout_provider: "azure_document_intelligence" });
  assertEquals(overridden.layout_provider, "azure_document_intelligence");
  assertEquals(overridden.extraction_provider, null);
});

// ── Task C: compatibility adapter (skeleton from an existing payload) ───────

function sampleUploadedFile() {
  return {
    id: "uf-123",
    org_id: "org-abc",
    file_name: "assignment.pdf",
    mime_type: "application/pdf",
    module_type: "leases",
    document_subtype: "assignment",
    status: "review_required",
    docling_raw: {
      extraction_method: "azure_layout",
      page_count: 4,
      _metadata: {
        provider: "azure_document_intelligence",
        api_version: "2024-11-30",
        page_markers_present: true,
        page_mapping_coverage: 0.95,
      },
    },
    normalized_output: {
      metadata: {
        extractionDebug: {
          vertex_fact_ledger: { document_profile: "assignment", facts_extracted_count: 12 },
        },
      },
    },
    ui_review_payload: {
      metadata: { pipeline: { started_at: "2026-07-01T00:00:00.000Z", finished_at: "2026-07-01T00:00:05.000Z" } },
    },
  };
}

function sampleLease() {
  return { id: "lease-456", org_id: "org-abc" };
}

Deno.test("buildDocumentIntelligenceV3Skeleton: v3 skeleton can be generated from an existing upload/lease payload (Task F.1)", () => {
  const uploadedFile = sampleUploadedFile();
  const lease = sampleLease();
  const contract = buildDocumentIntelligenceV3Skeleton({ uploadedFile, lease });

  const shape = validateDocumentIntelligenceV3ContractShape(contract);
  assert(shape.valid, `expected a valid contract, got errors: ${shape.errors.join(", ")}`);

  // Identifiers preserved.
  assertEquals(contract.document.uploaded_file_id, "uf-123");
  assertEquals(contract.document.lease_id, "lease-456");
  assertEquals(contract.document.org_id, "org-abc");
  assertEquals(contract.document.file_name, "assignment.pdf");
  assertEquals(contract.document.document_subtype, "assignment");

  // Existing parser/provider/debug metadata copied in.
  assertEquals(contract.layout.provider, "azure_document_intelligence");
  assertEquals(contract.layout.api_version, "2024-11-30");
  assertEquals(contract.layout.page_count, 4);
  assertEquals(contract.layout.page_markers_present, true);
  assertEquals(contract.processing.version.extraction_provider, "vertex_fact_ledger");
  assertEquals(contract.processing.status, "review_required");

  // Every v3-only section stays at its Phase 1 empty default.
  assertEquals(contract.claims, []);
  assertEquals(contract.canonical_fields, []);
  assertEquals(contract.profile.status, "unclassified");
});

Deno.test("buildDocumentIntelligenceV3Skeleton: does not mutate its inputs, does not touch ui_review_payload/normalized_output shape", () => {
  const uploadedFile = sampleUploadedFile();
  const lease = sampleLease();
  const uploadedFileSnapshot = JSON.parse(JSON.stringify(uploadedFile));
  const leaseSnapshot = JSON.parse(JSON.stringify(lease));

  buildDocumentIntelligenceV3Skeleton({ uploadedFile, lease });

  assertEquals(uploadedFile, uploadedFileSnapshot, "uploadedFile must be unchanged after building a skeleton");
  assertEquals(lease, leaseSnapshot, "lease must be unchanged after building a skeleton");
});

Deno.test("buildDocumentIntelligenceV3Skeleton: degrades cleanly with no uploaded file and no lease (never throws)", () => {
  const contract = buildDocumentIntelligenceV3Skeleton({ uploadedFile: null, lease: null });
  const shape = validateDocumentIntelligenceV3ContractShape(contract);
  assert(shape.valid);
  assertEquals(contract.document.uploaded_file_id, null);
  assertEquals(contract.document.lease_id, null);
});

Deno.test("buildDocumentIntelligenceV3Skeleton: legacy_hybrid row (no vertex_fact_ledger debug marker) is reported as legacy_hybrid", () => {
  const uploadedFile = sampleUploadedFile();
  uploadedFile.normalized_output = { metadata: { extractionDebug: {} } };
  const contract = buildDocumentIntelligenceV3Skeleton({ uploadedFile, lease: null });
  assertEquals(contract.processing.version.extraction_provider, "legacy_hybrid");
});

// ── Task E: claim / evidence shape validation ───────────────────────────────

function makeValidEvidence(overrides: Partial<DocumentIntelligenceV3Evidence> = {}): DocumentIntelligenceV3Evidence {
  return {
    document_id: "doc-1",
    uploaded_file_id: "uf-123",
    page: 2,
    source_text: "Assignee shall pay a Security Deposit of $8,575.00.",
    block_ids: ["b1"],
    polygon: [],
    support_type: "direct_quote",
    ...overrides,
  };
}

function makeValidClaim(overrides: Partial<DocumentIntelligenceV3Claim> = {}): DocumentIntelligenceV3Claim {
  return {
    claim_id: "claim-1",
    claim_type: "money_term",
    subject: { entity_id: "party_assignee", role: "assignee", display_name: "Narendra Pydi" },
    predicate: "must_pay",
    object: { type: "money", amount: 8575, currency: "USD" },
    conditions: [],
    effective_period: { from: "2023-11-07", to: null },
    extraction_mode: "explicit",
    confidence: { composite: 0.97 },
    evidence: [makeValidEvidence()],
    canonical_field_candidates: ["security_deposit"],
    validation: { status: "passed", evidence_sufficiency: "strong", rules: ["source_exists"] },
    importance: 0.6,
    supersession: {
      supersedes_claim_id: null,
      superseded_by_claim_id: null,
      current_status: "current",
      changed_by_document: null,
    },
    ...overrides,
  };
}

Deno.test("validateDocumentIntelligenceV3Evidence: a fully-shaped evidence object is valid (Task F.3)", () => {
  const result = validateDocumentIntelligenceV3Evidence(makeValidEvidence());
  assert(result.valid, `expected valid, got: ${result.errors.join(", ")}`);
});

Deno.test("validateDocumentIntelligenceV3Evidence: rejects an unknown support_type", () => {
  const result = validateDocumentIntelligenceV3Evidence(makeValidEvidence({ support_type: "eyeball" as any }));
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.includes("support_type")));
});

Deno.test("validateDocumentIntelligenceV3Evidence: rejects a missing required field", () => {
  const evidence: any = makeValidEvidence();
  delete evidence.source_text;
  const result = validateDocumentIntelligenceV3Evidence(evidence);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.includes("source_text")));
});

for (const mode of [
  "explicit",
  "normalized",
  "inferred",
  "calculated",
  "resolved_from_multiple_sources",
  "reviewer_entered",
] as const) {
  Deno.test(`validateDocumentIntelligenceV3Claim: extraction_mode "${mode}" is accepted`, () => {
    const result = validateDocumentIntelligenceV3Claim(makeValidClaim({ extraction_mode: mode }));
    assert(result.valid, `expected valid for mode ${mode}, got: ${result.errors.join(", ")}`);
  });
}

Deno.test("validateDocumentIntelligenceV3Claim: a fully-shaped claim with nested evidence is valid (Task F.3)", () => {
  const result = validateDocumentIntelligenceV3Claim(makeValidClaim());
  assert(result.valid, `expected valid, got: ${result.errors.join(", ")}`);
});

Deno.test("validateDocumentIntelligenceV3Claim: rejects an unknown extraction_mode", () => {
  const result = validateDocumentIntelligenceV3Claim(makeValidClaim({ extraction_mode: "guessed" as any }));
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.includes("extraction_mode")));
});

Deno.test("validateDocumentIntelligenceV3Claim: rejects a claim missing required top-level fields", () => {
  const claim: any = makeValidClaim();
  delete claim.supersession;
  delete claim.canonical_field_candidates;
  const result = validateDocumentIntelligenceV3Claim(claim);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.includes("supersession")));
  assert(result.errors.some((e) => e.includes("canonical_field_candidates")));
});

Deno.test("validateDocumentIntelligenceV3Claim: propagates a nested evidence shape error", () => {
  const claim = makeValidClaim({ evidence: [makeValidEvidence({ support_type: "bogus" as any })] });
  const result = validateDocumentIntelligenceV3Claim(claim);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.startsWith("evidence[0]:")));
});

// ── Task B/F.6: feature flag is inert and off by default ────────────────────

function fakeEnv(value: string | undefined) {
  return { get: (key: string) => (key === "ENABLE_DOCUMENT_INTELLIGENCE_V3" ? value : undefined) };
}

Deno.test("isDocumentIntelligenceV3Enabled: unset env means disabled (current behavior unchanged, Task F.6)", () => {
  assertFalse(isDocumentIntelligenceV3Enabled(fakeEnv(undefined)));
});

Deno.test("isDocumentIntelligenceV3Enabled: empty string, garbage, and 'false' all mean disabled", () => {
  assertFalse(isDocumentIntelligenceV3Enabled(fakeEnv("")));
  assertFalse(isDocumentIntelligenceV3Enabled(fakeEnv("nope")));
  assertFalse(isDocumentIntelligenceV3Enabled(fakeEnv("false")));
  assertFalse(isDocumentIntelligenceV3Enabled(fakeEnv("0")));
});

Deno.test("isDocumentIntelligenceV3Enabled: explicit truthy values enable it, case-insensitively", () => {
  assert(isDocumentIntelligenceV3Enabled(fakeEnv("true")));
  assert(isDocumentIntelligenceV3Enabled(fakeEnv("TRUE")));
  assert(isDocumentIntelligenceV3Enabled(fakeEnv("1")));
  assert(isDocumentIntelligenceV3Enabled(fakeEnv("on")));
});

Deno.test("isDocumentIntelligenceV3Enabled: real Deno.env, unset by default in this test run, is disabled", () => {
  Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  assertFalse(isDocumentIntelligenceV3Enabled());
});
