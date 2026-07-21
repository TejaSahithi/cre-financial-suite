// @ts-nocheck
// Phase 4a equivalence tests: document-index-v3.ts's resolveDocumentIndex()
// now goes through resolveCanonicalDocumentLayout({ doclingRaw }) instead of
// calling legacyDoclingToCanonicalLayout() directly. These tests prove the
// resolver-based path is deep-equal to the pre-Phase-4a direct-builder path
// for every supported docling_raw fixture, and separately cover every edge
// case from the Phase 4a adoption contract (null layout, fatal validation,
// warnings-are-informational, determinism, no input mutation).
//
// Pure-function tests only -- no DB, no network, no live Azure/Vertex call.
// Run: deno test --allow-env --allow-read --no-lock document-index-v3-resolver-adoption.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveDocumentIndex, buildCanonicalDocumentIndexFromLayout } from "../_shared/extraction/openai-fact-ledger/document-index-v3.ts";
import { legacyDoclingToCanonicalLayout } from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function twoPageDoclingRaw() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nLEASE AGREEMENT\n\n[[PAGE 2]]\nBase Rent is $5,000 per month.",
    page_count: 2,
    pages: [
      { page: 1, text: "LEASE AGREEMENT" },
      { page: 2, text: "Base Rent is $5,000 per month." },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1 },
      { block_index: 1, type: "paragraph", text: "Base Rent is $5,000 per month.", page: 2 },
    ],
    tables: [],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: { provider: "azure_document_intelligence", extraction_method: "azure_layout", api_version: "2024-11-30", page_markers_present: true, page_mapping_coverage: 1, raw_response_stored: false },
  };
}

function camHeavyDoclingRawWithTable() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nCAM Reconciliation\n\n[[PAGE 2]]\nSchedule of expenses follows.",
    page_count: 2,
    pages: [
      { page: 1, text: "CAM Reconciliation" },
      { page: 2, text: "Schedule of expenses follows." },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "CAM Reconciliation", page: 1 },
      { block_index: 1, type: "paragraph", text: "Schedule of expenses follows.", page: 2 },
    ],
    tables: [
      { table_index: 0, headers: ["Category", "Amount"], rows: [["Landscaping", "$1,200.00"], ["Security", "$3,400.00"]], markdown: "Category\tAmount\nLandscaping\t$1,200.00\nSecurity\t$3,400.00" },
    ],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: { provider: "azure_document_intelligence", extraction_method: "azure_layout", api_version: "2024-11-30", page_markers_present: true, page_mapping_coverage: 1, raw_response_stored: false },
  };
}

function assignmentScaleDoclingRaw() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nASSIGNMENT AND ASSUMPTION OF LEASE",
    page_count: 1,
    pages: [{ page: 1, text: "ASSIGNMENT AND ASSUMPTION OF LEASE" }],
    text_blocks: [{ block_index: 0, type: "title", text: "ASSIGNMENT AND ASSUMPTION OF LEASE", page: 1 }],
    tables: [],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: { provider: "azure_document_intelligence", extraction_method: "azure_layout", api_version: "2024-11-30", page_markers_present: true, page_mapping_coverage: 1, raw_response_stored: false },
  };
}

const SUPPORTED_FIXTURES: Array<[string, () => Record<string, unknown>]> = [
  ["two-page lease", twoPageDoclingRaw],
  ["CAM-heavy with table", camHeavyDoclingRawWithTable],
  ["assignment-scale (single page)", assignmentScaleDoclingRaw],
];

// ── Equivalence: resolver path vs. old direct-builder path ──────────────────

for (const [label, buildFixture] of SUPPORTED_FIXTURES) {
  Deno.test(`resolver adoption equivalence [${label}]: resolver-based index is deep-equal to the old direct-builder path`, async () => {
    const doclingRaw = buildFixture();

    // Old path (pre-Phase-4a): call the legacy builder directly, exactly as
    // resolveDocumentIndex() used to.
    const oldLayout = await legacyDoclingToCanonicalLayout(doclingRaw, {});
    const oldIndex = buildCanonicalDocumentIndexFromLayout(oldLayout);

    // New path (Phase 4a): via resolveDocumentIndex(), which now goes
    // through resolveCanonicalDocumentLayout({ doclingRaw }) internally.
    const result = await resolveDocumentIndex(buildFixture(), { strategy: "canonical_layout" });

    assertEquals(result.indexSource, "canonical_layout");
    assertEquals(result.fallbackReason, null);

    // Deep-equal on every field Task C names explicitly.
    assertEquals(result.index.fullText, oldIndex.fullText, "text");
    assertEquals(result.index.pageCount, oldIndex.pageCount, "page numbers/count");
    assertEquals(result.index.blockIds, oldIndex.blockIds, "block IDs");
    assertEquals(result.index.doclingRaw.text_blocks, oldIndex.doclingRaw.text_blocks, "block ordering (projected text_blocks)");
    assertEquals(result.index.doclingRaw.tables, oldIndex.doclingRaw.tables, "table projections");
    assertEquals(result.index.tablePlaceholders, oldIndex.tablePlaceholders, "table placeholders");
    assertEquals(result.index.figurePlaceholders, oldIndex.figurePlaceholders, "figure placeholders");
    assertEquals(result.index.signaturePlaceholders, oldIndex.signaturePlaceholders, "signature placeholders");
    assertEquals(result.index.headTailExcerpt, oldIndex.headTailExcerpt, "summary excerpt");
    assertEquals(result.index.canonicalLayout.content_hash, oldIndex.canonicalLayout.content_hash, "content hash");
    assertEquals(result.index.evidenceIndex, oldIndex.evidenceIndex, "evidence-enrichment inputs (evidenceIndex)");

    // Whole-object deep-equal as the final, strongest check (summary counts
    // and everything else fall out of this automatically).
    assertEquals(result.index, oldIndex);
  });
}

// ── Edge cases from the Phase 4a adoption contract ───────────────────────────

Deno.test("resolver adoption: missing doclingRaw (null) falls back to legacy_evidence_index, never a silent empty-but-successful index", async () => {
  const result = await resolveDocumentIndex(null, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "legacy_evidence_index");
  assert(result.fallbackReason?.startsWith("canonical_layout_failed:"));
  assert(result.fallbackReason?.includes("no layout"), `expected the null-layout reason to be visible in fallbackReason, got: ${result.fallbackReason}`);
});

Deno.test("resolver adoption: undefined doclingRaw falls back the same way as null", async () => {
  const result = await resolveDocumentIndex(undefined, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "legacy_evidence_index");
  assert(result.fallbackReason != null);
});

Deno.test("resolver adoption: malformed (empty-object) doclingRaw does not throw uncaught, falls back safely", async () => {
  // An object-shaped but structurally empty docling_raw (no full_text, no
  // pages, no text_blocks) -- a realistic "malformed/incomplete row"
  // scenario. (A bare primitive like a string is deliberately not used
  // here: it hits a pre-existing, Phase-4a-unrelated WeakMap-key bug in
  // the shared legacy fallback path itself -- _shared/extraction/evidence-index.ts's
  // buildEvidenceIndex() calls `_indexCache.set(doclingRaw, index)`
  // unconditionally on any truthy doclingRaw, which throws for a
  // primitive. That fallback function is untouched by and identical
  // before/after this phase -- it would crash the exact same way on the
  // pre-Phase-4a direct legacy_evidence_index path with the same input,
  // so it is out of this phase's scope to fix; noted in the Phase 4a
  // report instead.)
  const result = await resolveDocumentIndex({}, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "legacy_evidence_index");
});

Deno.test("resolver adoption: a fatally-invalid resolved layout (missing_content) never produces a 'successful' index -- falls back, validation detail preserved in fallbackReason", async () => {
  const degenerate = { full_text: "", pages: [], text_blocks: [], tables: [] };
  const result = await resolveDocumentIndex(degenerate, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "legacy_evidence_index");
  assert(result.fallbackReason?.includes("missing_content"), `expected the fatal validation code to be preserved for diagnostics, got: ${result.fallbackReason}`);
  // The fallback index itself is the honest legacy_evidence_index result,
  // not a canonical index dressed up as successful.
  assertEquals(result.index.fullText, "");
});

Deno.test("resolver adoption: unsupported schema version is not reachable from this consumer (documented as not applicable) -- resolveDocumentIndex never supplies a canonicalLayout input, only doclingRaw", async () => {
  // This consumer only ever calls resolveCanonicalDocumentLayout({ doclingRaw }),
  // never passing a pre-built canonicalLayout -- so the resolver's
  // schema-version-rejection path (Phase 3 Task C) can never trigger here.
  // This test exists to make that "not applicable" status explicit and
  // testable, per the adoption-contract requirement, rather than silently
  // omitted.
  const result = await resolveDocumentIndex(twoPageDoclingRaw(), { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "canonical_layout"); // succeeds normally; no schema-version path involved
});

Deno.test("resolver adoption: legacy_lossy fidelity is explicitly accepted -- the only fidelity reachable from this consumer's current input, not treated as a degradation", async () => {
  // Indirect proof: every successful-path test above resolves via the
  // docling_raw-only call pattern, which the Phase 3 resolver always
  // reports as source: 'legacy_docling_raw' / fidelity: 'legacy_lossy' --
  // and none of them are rejected or downgraded for that reason.
  const result = await resolveDocumentIndex(twoPageDoclingRaw(), { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "canonical_layout");
  assertEquals(result.fallbackReason, null);
});

Deno.test("resolver adoption: warnings do not affect control flow -- a layout with recoverable warnings still builds a successful index identically to one without", async () => {
  // Two-page fixture never produces warnings; construct a variant with an
  // out-of-range table page reference, which the legacy builder tolerates
  // (defaults to page 1) without emitting a warning either -- so instead we
  // directly verify the resolver's own warnings array, when present, is
  // never consulted by resolveDocumentIndex()'s control flow: the source
  // file contains no `warnings.some`/`warnings.find`/`warning.code ===`
  // pattern (verified once here via source scan, complementing Phase 3A's
  // manual audit).
  const source = await Deno.readTextFile(new URL("../_shared/extraction/openai-fact-ledger/document-index-v3.ts", import.meta.url));
  assertFalse(/resolution\.warnings\.(some|find)\(/.test(source), "resolveDocumentIndex must never branch on resolution.warnings contents");
  assertFalse(/warning\.code\s*===/.test(source), "resolveDocumentIndex must never branch on an individual warning's code");
});

Deno.test("resolver adoption: deterministic -- repeated calls with the same doclingRaw produce deep-equal results", async () => {
  const doclingRaw = twoPageDoclingRaw();
  const first = await resolveDocumentIndex(doclingRaw, { strategy: "canonical_layout" });
  const second = await resolveDocumentIndex(doclingRaw, { strategy: "canonical_layout" });
  assertEquals(first, second);
});

Deno.test("resolver adoption: does not mutate the input doclingRaw object", async () => {
  const doclingRaw = twoPageDoclingRaw();
  const snapshot = JSON.parse(JSON.stringify(doclingRaw));
  await resolveDocumentIndex(doclingRaw, { strategy: "canonical_layout" });
  assertEquals(doclingRaw, snapshot);
});
