// @ts-nocheck
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildEvidenceSufficiencyCounts,
  classifyEvidenceSufficiency,
  isSourceBackedByLegacyEvidence,
} from "../_shared/extraction/document-intelligence-v3/readiness.ts";

const textEvidence = (overrides = {}) => ({
  claim_id: "claim-1",
  page: 2,
  source_text: "Tenant: Acme Inc.",
  block_ids: [],
  polygon: [],
  support_type: "direct_quote",
  ...overrides,
});

Deno.test("evidence sufficiency: no evidence -> none", () => {
  const result = classifyEvidenceSufficiency([]);
  assertEquals(result.evidence_sufficiency, "none");
  assertEquals(result.evidence_summary.evidence_rows, 0);
  assertEquals(result.evidence_warnings, []);
});

Deno.test("evidence sufficiency: source_text only -> text_only", () => {
  const result = classifyEvidenceSufficiency([textEvidence()]);
  assertEquals(result.evidence_sufficiency, "text_only");
  assertEquals(result.evidence_summary.rows_with_source_text, 1);
  assert(result.evidence_warnings.includes("text_only_no_block_anchor"));
});

Deno.test("evidence sufficiency: source_text + block_ids -> block_anchored", () => {
  const result = classifyEvidenceSufficiency([textEvidence({ block_ids: ["page-2:block-4"] })]);
  assertEquals(result.evidence_sufficiency, "block_anchored");
  assertEquals(result.evidence_summary.rows_with_block_ids, 1);
});

Deno.test("evidence sufficiency: source_text + polygon -> visual_anchored", () => {
  const result = classifyEvidenceSufficiency([textEvidence({ polygon: [0, 0, 1, 1] })]);
  assertEquals(result.evidence_sufficiency, "visual_anchored");
  assertEquals(result.evidence_summary.rows_with_polygon, 1);
});

Deno.test("evidence sufficiency: calculated support_type -> calculated", () => {
  const result = classifyEvidenceSufficiency([textEvidence({ source_text: "monthly_rent * 12", support_type: "calculated" })]);
  assertEquals(result.evidence_sufficiency, "calculated");
  assertEquals(result.evidence_summary.support_types, ["calculated"]);
});

Deno.test("evidence sufficiency: cross_reference and multi_source -> cross_reference", () => {
  assertEquals(
    classifyEvidenceSufficiency([textEvidence({ support_type: "cross_reference", uploaded_file_id: "uf-1" })]).evidence_sufficiency,
    "cross_reference",
  );
  assertEquals(
    classifyEvidenceSufficiency([textEvidence({ support_type: "multi_source", uploaded_file_id: "uf-1" })]).evidence_sufficiency,
    "cross_reference",
  );
});

Deno.test("evidence sufficiency: evidence row missing source_text warns and is insufficient", () => {
  const result = classifyEvidenceSufficiency([textEvidence({ source_text: null })]);
  assertEquals(result.evidence_sufficiency, "insufficient");
  assert(result.evidence_warnings.includes("missing_source_text"));
});

Deno.test("evidence sufficiency: validation drop prevents false high sufficiency", () => {
  const result = classifyEvidenceSufficiency(
    [textEvidence({ block_ids: ["page-2:block-4"] })],
    [{ field_key: "landlord_name", reason: "invalid_markup_value", claim_id: null }],
  );
  assertEquals(result.evidence_sufficiency, "insufficient");
});

Deno.test("source_backed compatibility: source_text remains backed without block_ids or polygon", () => {
  assertEquals(isSourceBackedByLegacyEvidence([textEvidence({ block_ids: [], polygon: [] })]), true);
});

Deno.test("evidence sufficiency counts include every run-level bucket", () => {
  const counts = buildEvidenceSufficiencyCounts([
    { evidence_sufficiency: "none" },
    { evidence_sufficiency: "text_only" },
    { evidence_sufficiency: "block_anchored" },
    { evidence_sufficiency: "visual_anchored" },
    { evidence_sufficiency: "calculated" },
    { evidence_sufficiency: "cross_reference" },
    { evidence_sufficiency: "insufficient" },
  ]);
  assertEquals(counts, {
    fields_with_no_evidence: 1,
    fields_with_text_only_evidence: 1,
    fields_with_block_anchored_evidence: 1,
    fields_with_visual_anchored_evidence: 1,
    fields_with_calculated_evidence: 1,
    fields_with_cross_reference_evidence: 1,
    fields_with_insufficient_evidence: 1,
  });
});
