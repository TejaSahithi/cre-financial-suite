// @ts-nocheck
// Phase 2 unit tests for the Document Intelligence v3 fact mapper
// (supabase/functions/_shared/extraction/document-intelligence-v3/fact-mapper.ts).
// Pure-function tests only -- no DB, no network.
// Run: deno test --allow-env --allow-read --no-lock document-intelligence-v3-fact-mapper.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  extractVertexFactLedgerClaims,
  extractValidationDrops,
  extractCanonicalFieldProjections,
  vertexFactLedgerRan,
} from "../_shared/extraction/document-intelligence-v3/fact-mapper.ts";

const ORG_ID = "org-1";
const UPLOADED_FILE_ID = "uf-1";

function legacyHybridResult() {
  return {
    rows: [{ monthly_rent: 5000 }],
    method: "hybrid",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        merged_field_sources: { monthly_rent: { value: 5000, source: "rule", confidence: 0.8 } },
      },
    },
  };
}

function vertexFactLedgerResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{ monthly_rent: 5000 }],
    method: "llm_only",
    warnings: [],
    validationErrors: [
      { field: "start_date", message: "Invalid date format", receivedValue: "not-a-date", rowIndex: 0 },
    ],
    metadata: {
      extractionDebug: {
        merged_field_sources: {
          monthly_rent: { value: 5000, source: "llm", confidence: 0.9, source_text: "Base Rent: $5,000 per month.", source_page: 2 },
          start_date: { value: null, source: "llm", confidence: 0.5, source_text: null, source_page: null },
        },
        validated_field_values: {
          monthly_rent: { value: 5000, source: "llm", confidence: 0.9, source_text: "Base Rent: $5,000 per month.", source_page: 2 },
          start_date: { value: null, source: "llm", confidence: 0.5, source_text: null, source_page: null },
        },
        vertex_fact_ledger: {
          document_profile: "full_lease",
          document_profile_confidence: 0.9,
          document_profile_method: "vertex",
          facts_extracted_count: 2,
          facts_mapped_count: 1,
          facts_unmapped_count: 1,
          approval_blockers: [],
          dynamic_items: [
            {
              item_id: "vertex_fact:clause:governing_law:abc",
              document_id: null,
              lease_id: null,
              item_type: "clause:governing_law",
              label: "Governing Law",
              value: "Delaware",
              source_text: "Governed by the laws of the State of Delaware.",
              source_page: 5,
              confidence: 0.8,
              field_key: null,
            },
          ],
        },
        ...overrides,
      },
    },
  };
}

// ── vertexFactLedgerRan ──────────────────────────────────────────────────────

Deno.test("vertexFactLedgerRan: false for a legacy_hybrid result", () => {
  assertFalse(vertexFactLedgerRan(legacyHybridResult()));
});

Deno.test("vertexFactLedgerRan: true whenever the vertex_fact_ledger debug marker is present", () => {
  assert(vertexFactLedgerRan(vertexFactLedgerResult()));
});

// ── extractVertexFactLedgerClaims (Task B/C) ─────────────────────────────────

Deno.test("extractVertexFactLedgerClaims: legacy_hybrid result produces zero claims (Task B: no fabrication)", () => {
  const output = extractVertexFactLedgerClaims({
    result: legacyHybridResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  assertFalse(output.factsPresent);
  assertEquals(output.claims.length, 0);
  assertEquals(output.evidence.length, 0);
});

Deno.test("extractVertexFactLedgerClaims: a mapped canonical field becomes a claim_type=canonical_field claim with evidence", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: "lease-1",
  });
  assert(output.factsPresent);

  const rentClaim = output.claims.find((c) => c.claim_type === "canonical_field" && c.object.field_key === "monthly_rent");
  assert(rentClaim, "expected a canonical_field claim for monthly_rent");
  assertEquals(rentClaim.org_id, ORG_ID);
  assertEquals(rentClaim.uploaded_file_id, UPLOADED_FILE_ID);
  assertEquals(rentClaim.lease_id, "lease-1");
  assertEquals(rentClaim.predicate, "has_value");
  assertEquals(rentClaim.object.value, 5000);
  assertEquals(rentClaim.extraction_mode, "explicit");
  assertEquals(rentClaim.confidence.composite, 0.9);
  assertEquals(rentClaim.canonical_field_candidates, ["monthly_rent"]);
  assertEquals(rentClaim.validation_status, "passed");
  assertEquals(rentClaim.evidence_sufficiency, "strong");

  const rentEvidence = output.evidence.find((e) => e.claim_id === rentClaim.id);
  assert(rentEvidence, "expected evidence for the monthly_rent claim");
  assertEquals(rentEvidence.page, 2);
  assertEquals(rentEvidence.source_text, "Base Rent: $5,000 per month.");
  assertEquals(rentEvidence.support_type, "direct_quote");
});

Deno.test("extractVertexFactLedgerClaims: a null-valued mapped field produces no claim (nothing to assert)", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const startDateClaim = output.claims.find((c) => c.object?.field_key === "start_date");
  assertEquals(startDateClaim, undefined, "a field with value=null must not become a claim");
});

Deno.test("extractVertexFactLedgerClaims: a validation error on a field marks that field's claim as validation_status=failed", () => {
  const result = vertexFactLedgerResult({
    validated_field_values: {
      monthly_rent: { value: 5000, source: "llm", confidence: 0.9, source_text: "Base Rent: $5,000.", source_page: 2 },
    },
  });
  result.validationErrors = [{ field: "monthly_rent", message: "out of range", receivedValue: 5000, rowIndex: 0 }];
  const output = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });
  const claim = output.claims.find((c) => c.object?.field_key === "monthly_rent");
  assert(claim);
  assertEquals(claim.validation_status, "failed");
});

Deno.test("extractVertexFactLedgerClaims: an unmapped dynamic fact becomes a claim carrying its original clause category", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const dynamicClaim = output.claims.find((c) => c.claim_type === "clause:governing_law");
  assert(dynamicClaim, "expected a claim for the unmapped governing_law fact");
  assertEquals(dynamicClaim.predicate, "mentions");
  assertEquals(dynamicClaim.object.value, "Delaware");
  assertEquals(dynamicClaim.canonical_field_candidates, []);

  const dynamicEvidence = output.evidence.find((e) => e.claim_id === dynamicClaim.id);
  assert(dynamicEvidence);
  assertEquals(dynamicEvidence.page, 5);
  assertEquals(dynamicEvidence.source_text, "Governed by the laws of the State of Delaware.");
});

Deno.test("extractVertexFactLedgerClaims: a fact with no source_text produces a claim but zero evidence rows (never fabricates evidence)", () => {
  const result = vertexFactLedgerResult();
  result.metadata.extractionDebug.vertex_fact_ledger.dynamic_items = [
    {
      item_id: "vertex_fact:clause:x:1",
      item_type: "clause:x",
      label: "X",
      value: "something",
      source_text: null,
      source_page: null,
      confidence: 0.5,
      field_key: null,
    },
  ];
  const output = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });
  const claim = output.claims.find((c) => c.claim_type === "clause:x");
  assert(claim);
  assertEquals(claim.evidence_sufficiency, "none");
  assertEquals(output.evidence.filter((e) => e.claim_id === claim.id).length, 0);
});

// ── extractValidationDrops ───────────────────────────────────────────────────

Deno.test("extractValidationDrops: maps result.validationErrors into validation_drops rows for any provider", () => {
  const drops = extractValidationDrops({ result: vertexFactLedgerResult(), orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID });
  assertEquals(drops.length, 1);
  assertEquals(drops[0].field_key, "start_date");
  assertEquals(drops[0].bad_value, "not-a-date");
  assertEquals(drops[0].reason, "Invalid date format");
  assertEquals(drops[0].action, "dropped");
});

Deno.test("extractValidationDrops: empty validationErrors produces zero drops", () => {
  const drops = extractValidationDrops({ result: legacyHybridResult(), orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID });
  assertEquals(drops.length, 0);
});

// ── extractCanonicalFieldProjections ────────────────────────────────────────

Deno.test("extractCanonicalFieldProjections: legacy_hybrid produces zero projections (source-gated, like claims)", () => {
  const rows = extractCanonicalFieldProjections({
    result: legacyHybridResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  assertEquals(rows.length, 0);
});

Deno.test("extractCanonicalFieldProjections: vertex_fact_ledger produces one row per attempted field, status reflects value presence", () => {
  const rows = extractCanonicalFieldProjections({
    result: vertexFactLedgerResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  assertEquals(rows.length, 2);
  const rent = rows.find((r) => r.field_key === "monthly_rent");
  const start = rows.find((r) => r.field_key === "start_date");
  assert(rent && start);
  assertEquals(rent.status, "auto_populated");
  assertEquals(rent.value, 5000);
  assertEquals(rent.validation_status, "passed");
  assertEquals(start.status, "missing");
  assertEquals(start.value, null);
});

Deno.test("extractCanonicalFieldProjections: given the matching claims, links source_claim_ids to the canonical_field claim for that field_key (Phase 3 extension)", () => {
  const result = vertexFactLedgerResult();
  const { claims } = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });
  const rows = extractCanonicalFieldProjections({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null, claims });

  const rentRow = rows.find((r) => r.field_key === "monthly_rent");
  const rentClaim = claims.find((c) => c.claim_type === "canonical_field" && c.object.field_key === "monthly_rent");
  assert(rentRow && rentClaim);
  assertEquals(rentRow.source_claim_ids, [rentClaim.id]);

  // start_date had no value, so it never became a claim -- its projection
  // row must not link to a claim that doesn't exist.
  const startRow = rows.find((r) => r.field_key === "start_date");
  assert(startRow);
  assertEquals(startRow.source_claim_ids, []);
});

Deno.test("extractCanonicalFieldProjections: omitting claims degrades to empty source_claim_ids (backward compatible)", () => {
  const rows = extractCanonicalFieldProjections({
    result: vertexFactLedgerResult(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  assert(rows.every((r) => Array.isArray(r.source_claim_ids) && r.source_claim_ids.length === 0));
});

// ── Phase 7: evidence anchor consumption (Task B/C, G.1-G.4) ────────────────

function vertexFactLedgerResultWithEvidenceAnchors() {
  return vertexFactLedgerResult({
    vertex_fact_ledger: {
      document_profile: "full_lease",
      document_profile_confidence: 0.9,
      document_profile_method: "vertex",
      facts_extracted_count: 2,
      facts_mapped_count: 1,
      facts_unmapped_count: 1,
      approval_blockers: [],
      document_index_source: "canonical_layout",
      document_index_fallback_reason: null,
      dynamic_items: [
        {
          item_id: "vertex_fact:clause:governing_law:abc",
          document_id: null,
          item_type: "clause:governing_law",
          label: "Governing Law",
          value: "Delaware",
          source_text: "Governed by the laws of the State of Delaware.",
          source_page: 5,
          confidence: 0.8,
          field_key: null,
        },
      ],
      evidence_anchors: [
        {
          category: "clause:rent_escalation",
          source_text: "Base Rent: $5,000 per month.",
          source_page: 2,
          block_ids: ["block-3"],
          polygon: [1, 2, 3, 4],
          support_type: "direct_quote",
        },
        {
          category: "clause:governing_law",
          source_text: "Governed by the laws of the State of Delaware.",
          source_page: 5,
          block_ids: [],
          polygon: [],
          support_type: null,
        },
      ],
    },
  });
}

Deno.test("extractVertexFactLedgerClaims: a mapped field with a matching evidence anchor persists real block_ids (Task G.1)", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResultWithEvidenceAnchors(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const rentClaim = output.claims.find((c) => c.claim_type === "canonical_field" && c.object.field_key === "monthly_rent");
  const rentEvidence = output.evidence.find((e) => e.claim_id === rentClaim.id);
  assertEquals(rentEvidence.block_ids, ["block-3"]);
});

Deno.test("extractVertexFactLedgerClaims: a matching evidence anchor persists real polygon data (Task G.2)", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResultWithEvidenceAnchors(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const rentClaim = output.claims.find((c) => c.object?.field_key === "monthly_rent");
  const rentEvidence = output.evidence.find((e) => e.claim_id === rentClaim.id);
  assertEquals(rentEvidence.polygon, [1, 2, 3, 4]);
  assertEquals(rentEvidence.support_type, "direct_quote");
});

Deno.test("extractVertexFactLedgerClaims: an evidence anchor with no block match coerces a null support_type to the safe default (Task G.2 cont.)", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResultWithEvidenceAnchors(),
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const dynamicClaim = output.claims.find((c) => c.claim_type === "clause:governing_law");
  const dynamicEvidence = output.evidence.find((e) => e.claim_id === dynamicClaim.id);
  assertEquals(dynamicEvidence.block_ids, []);
  assertEquals(dynamicEvidence.polygon, []);
  assertEquals(dynamicEvidence.support_type, "direct_quote", "null support_type must never reach the DB -- coerced to the safe default");
});

Deno.test("extractVertexFactLedgerClaims: missing evidence_anchors (Phase 6 not run, or legacy_evidence_index) preserves exact Phase 2 behavior (Task G.3)", () => {
  const output = extractVertexFactLedgerClaims({
    result: vertexFactLedgerResult(), // no evidence_anchors at all
    orgId: ORG_ID,
    uploadedFileId: UPLOADED_FILE_ID,
    leaseId: null,
  });
  const rentClaim = output.claims.find((c) => c.object?.field_key === "monthly_rent");
  const rentEvidence = output.evidence.find((e) => e.claim_id === rentClaim.id);
  assertEquals(rentEvidence.block_ids, []);
  assertEquals(rentEvidence.polygon, []);
  assertEquals(rentEvidence.support_type, "direct_quote");
});

Deno.test("extractVertexFactLedgerClaims: an evidence_anchors entry that doesn't match any fact's source_text is simply unused, never mismatched onto a different claim", () => {
  const result = vertexFactLedgerResultWithEvidenceAnchors();
  result.metadata.extractionDebug.vertex_fact_ledger.evidence_anchors.push({
    category: "clause:unrelated",
    source_text: "This text appears nowhere in any fact.",
    source_page: 9,
    block_ids: ["block-99"],
    polygon: [],
    support_type: "direct_quote",
  });
  const output = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });
  assert(output.evidence.every((e) => !e.block_ids.includes("block-99")), "an unrelated anchor must never attach to an unrelated claim");
});

Deno.test("extractVertexFactLedgerClaims: never fabricates -- still zero evidence rows when a fact has no source_text at all (Task G.4)", () => {
  const result = vertexFactLedgerResultWithEvidenceAnchors();
  result.metadata.extractionDebug.merged_field_sources.start_date = { value: null, source: "llm", confidence: 0.5, source_text: null, source_page: null };
  const output = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });
  const startClaim = output.claims.find((c) => c.object?.field_key === "start_date");
  assertEquals(startClaim, undefined, "no value means no claim at all, regardless of evidence_anchors being present");
});
