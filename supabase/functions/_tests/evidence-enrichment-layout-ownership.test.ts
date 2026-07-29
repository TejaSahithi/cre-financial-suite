// @ts-nocheck
// Phase 4C: evidence-enrichment review. Two structural guards plus one
// behavioral test for a real gap the review surfaced.
//
// Structural guards protect the exact architectural boundary Phase 4C
// verified by tracing the call graph: evidence enrichment never
// independently constructs or resolves a CanonicalDocumentLayout -- it is a
// pure reuse of the single layout orchestrator.ts resolves once per
// pipeline run (see docs/lease-extraction-architecture-audit-2026-07-29.md).
// These supplement, not replace, the existing behavioral coverage already
// in document-intelligence-v3-document-index.test.ts, document-intelligence-v3-fact-mapper.test.ts,
// and openai-fact-ledger.test.ts, which already prove the canonical-layout
// path and the legacy-fallback path end to end (cited, not duplicated, in
// the Phase 4C report).
//
// The behavioral test documents (does not fix) a real gap the review found:
// fact-mapper.ts's evidence-anchor index is keyed only by source_text, so
// two different facts sharing identical text (repeated headers/footers,
// duplicate defined terms, boilerplate clauses) can collide -- the first
// anchor for a given source_text wins, and a later, different-page
// occurrence is silently discarded rather than attached to the correct claim.
//
// Pure-function tests only -- no DB, no network.
// Run: deno test --allow-env --allow-read --no-lock evidence-enrichment-layout-ownership.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractVertexFactLedgerClaims } from "../_shared/extraction/document-intelligence-v3/fact-mapper.ts";

const FACT_MAPPER_PATH = new URL("../_shared/extraction/document-intelligence-v3/fact-mapper.ts", import.meta.url);
const DOCUMENT_INDEX_V3_PATH = new URL("../_shared/extraction/openai-fact-ledger/document-index-v3.ts", import.meta.url);

const LAYOUT_CONSTRUCTION_SYMBOLS = [
  "resolveCanonicalDocumentLayout",
  "legacyDoclingToCanonicalLayout",
  "buildCanonicalLayoutFromAzureLikeOutput",
  "azureAnalyzeResultToCanonicalLayout",
];

function stripComments(source: string): string {
  // Strips /* */ and // comments so doc-comment mentions of these symbol
  // names (which exist deliberately, describing the architecture) don't
  // produce a false positive -- only real code references matter here.
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// ── Structural guard 1: fact-mapper.ts never imports/calls a layout builder ──

Deno.test("evidence enrichment: fact-mapper.ts contains no functional reference to any layout-construction symbol", async () => {
  const source = stripComments(await Deno.readTextFile(FACT_MAPPER_PATH));
  for (const symbol of LAYOUT_CONSTRUCTION_SYMBOLS) {
    assertFalse(source.includes(symbol), `fact-mapper.ts must never reference ${symbol} -- it should only ever read the already-computed evidence_anchors array`);
  }
});

// ── Structural guard 2: enrichFactWithBlockEvidence's own body is clean ─────

Deno.test("evidence enrichment: enrichFactWithBlockEvidence's own function body contains no layout-construction call", async () => {
  const fullSource = await Deno.readTextFile(DOCUMENT_INDEX_V3_PATH);
  const startMarker = "export function enrichFactWithBlockEvidence";
  const startIndex = fullSource.indexOf(startMarker);
  assert(startIndex >= 0, "enrichFactWithBlockEvidence not found -- has it been renamed or moved?");
  // It's the last export in this file (Phase 4a); isolate from its
  // signature to end of file so this test does not depend on that staying
  // true, but still isolates just this function's own body, not the whole
  // module (which legitimately imports resolveCanonicalDocumentLayout for
  // resolveDocumentIndex, a different function).
  const nextExportIndex = fullSource.indexOf("\nexport ", startIndex + startMarker.length);
  const functionBody = stripComments(nextExportIndex >= 0 ? fullSource.slice(startIndex, nextExportIndex) : fullSource.slice(startIndex));

  for (const symbol of LAYOUT_CONSTRUCTION_SYMBOLS) {
    assertFalse(functionBody.includes(symbol), `enrichFactWithBlockEvidence's own body must never call ${symbol} -- it must only ever read the layout parameter it was handed`);
  }
});

// ── Behavioral: documents the source-text collision risk (not fixed here) ──

const ORG_ID = "org-1";
const UPLOADED_FILE_ID = "uf-1";

Deno.test("evidence enrichment: KNOWN LIMITATION -- two facts sharing identical source_text collide in fact-mapper's anchor index (first anchor wins, second is silently discarded)", () => {
  const SHARED_TEXT = "Tenant shall maintain insurance coverage as required herein.";

  const result = {
    rows: [{ insurance_clause_page2: SHARED_TEXT, insurance_clause_page7: SHARED_TEXT }],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        merged_field_sources: {
          // Two distinct fields whose extracted value happens to be the
          // exact same boilerplate sentence, appearing verbatim on two
          // different pages (e.g. a clause restated in an amendment).
          insurance_clause_page2: { value: SHARED_TEXT, source: "llm", confidence: 0.9, source_text: SHARED_TEXT, source_page: 2 },
          insurance_clause_page7: { value: SHARED_TEXT, source: "llm", confidence: 0.9, source_text: SHARED_TEXT, source_page: 7 },
        },
        validated_field_values: {
          insurance_clause_page2: { value: SHARED_TEXT, source: "llm", confidence: 0.9, source_text: SHARED_TEXT, source_page: 2 },
          insurance_clause_page7: { value: SHARED_TEXT, source: "llm", confidence: 0.9, source_text: SHARED_TEXT, source_page: 7 },
        },
        vertex_fact_ledger: {
          document_profile: "full_lease",
          document_profile_confidence: 0.9,
          document_profile_method: "vertex",
          facts_extracted_count: 2,
          facts_mapped_count: 2,
          facts_unmapped_count: 0,
          approval_blockers: [],
          document_index_source: "canonical_layout",
          document_index_fallback_reason: null,
          dynamic_items: [],
          // orchestrator.ts independently resolved each fact against its
          // OWN sourcePage via enrichFactWithBlockEvidence -- correctly
          // producing two DIFFERENT block_ids here, since each anchor was
          // resolved against the correct page. The collision happens
          // downstream, in fact-mapper's flat source_text-keyed index.
          evidence_anchors: [
            { category: "canonical_field", source_text: SHARED_TEXT, source_page: 2, block_ids: ["block-page2"], polygon: [1, 1, 2, 2], support_type: "direct_quote" },
            { category: "canonical_field", source_text: SHARED_TEXT, source_page: 7, block_ids: ["block-page7"], polygon: [3, 3, 4, 4], support_type: "direct_quote" },
          ],
        },
      },
    },
  };

  const output = extractVertexFactLedgerClaims({ result, orgId: ORG_ID, uploadedFileId: UPLOADED_FILE_ID, leaseId: null });

  const page2Claim = output.claims.find((c) => c.object?.field_key === "insurance_clause_page2");
  const page7Claim = output.claims.find((c) => c.object?.field_key === "insurance_clause_page7");
  const page2Evidence = output.evidence.find((e) => e.claim_id === page2Claim.id);
  const page7Evidence = output.evidence.find((e) => e.claim_id === page7Claim.id);

  // Documents the known limitation: the page-7 claim incorrectly receives
  // the page-2 anchor (the first one encountered wins in
  // buildEvidenceAnchorIndex's `index.has(sourceText)` skip check), rather
  // than its own correctly-resolved block_ids. This is deterministic (not
  // flaky/random) but semantically wrong for the second occurrence -- the
  // Phase 4C report records this as a medium risk, not fixed here.
  assertEquals(page2Evidence.block_ids, ["block-page2"], "the first-seen anchor's own claim gets the correct anchor");
  assertEquals(page7Evidence.block_ids, ["block-page2"], "KNOWN LIMITATION: the second claim incorrectly inherits the first anchor's block_ids because the index is keyed only by source_text");
  assertFalse(
    JSON.stringify(page7Evidence.block_ids) === JSON.stringify(["block-page7"]),
    "if this assertion ever starts failing, the collision has been fixed -- update this test and the Phase 4C report's risk register together, do not just delete the test",
  );
});
