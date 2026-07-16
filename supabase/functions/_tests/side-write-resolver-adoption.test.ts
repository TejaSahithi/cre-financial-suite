// @ts-nocheck
// Phase 4b equivalence tests: side-write.ts's computeCanonicalLayoutAndSummary()
// (not exported) now obtains its layout via
// resolveCanonicalDocumentLayout({ doclingRaw }) instead of calling
// legacyDoclingToCanonicalLayout() directly. Since the function itself is
// private, these tests prove equivalence at the exact computation chain it
// now performs -- resolveCanonicalDocumentLayout({ doclingRaw }) +
// summarizeCanonicalLayout() vs. the old legacyDoclingToCanonicalLayout() +
// summarizeCanonicalLayout() -- and separately verify every edge case from
// the Phase 4b adoption contract. The DB-backed equivalent of this proof
// (against the real document_intelligence_runs.layout_summary column) lives
// in document-intelligence-v3-side-write.property.test.ts.
//
// Pure-function tests only -- no DB, no network, no live Azure/Vertex call.
// Run: deno test --allow-env --allow-read --no-lock side-write-resolver-adoption.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveCanonicalDocumentLayout } from "../_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts";
import { legacyDoclingToCanonicalLayout, summarizeCanonicalLayout } from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";

// ── Fixtures (same scale-naming convention as Phase 2/4a) ───────────────────

function baseLeaseScaleDoclingRaw() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nLEASE AGREEMENT\n\n[[PAGE 2]]\nBase Rent is $8,500 per month.\n\n[[PAGE 3]]\nTerm: 10 years.",
    page_count: 3,
    pages: [
      { page: 1, text: "LEASE AGREEMENT" },
      { page: 2, text: "Base Rent is $8,500 per month." },
      { page: 3, text: "Term: 10 years." },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1 },
      { block_index: 1, type: "paragraph", text: "Base Rent is $8,500 per month.", page: 2 },
      { block_index: 2, type: "paragraph", text: "Term: 10 years.", page: 3 },
    ],
    tables: [],
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

function camTableHeavyScaleDoclingRaw() {
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
      { table_index: 0, headers: ["Category", "Amount"], rows: [["Landscaping", "$1,200.00"], ["Security", "$3,400.00"], ["Insurance", "$2,100.00"]], markdown: "Category\tAmount\nLandscaping\t$1,200.00\nSecurity\t$3,400.00\nInsurance\t$2,100.00" },
    ],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: { provider: "azure_document_intelligence", extraction_method: "azure_layout", api_version: "2024-11-30", page_markers_present: true, page_mapping_coverage: 1, raw_response_stored: false },
  };
}

const SUPPORTED_FIXTURES: Array<[string, () => Record<string, unknown>]> = [
  ["base-lease-scale", baseLeaseScaleDoclingRaw],
  ["assignment-scale", assignmentScaleDoclingRaw],
  ["CAM-table-heavy-scale", camTableHeavyScaleDoclingRaw],
];

// ── Equivalence: resolver-based computation chain vs. the old direct chain ──

for (const [label, buildFixture] of SUPPORTED_FIXTURES) {
  Deno.test(`side-write resolver adoption equivalence [${label}]: layout_summary and content_hash are identical to the old direct-builder chain`, async () => {
    const doclingRaw = buildFixture();

    // Old chain (pre-Phase-4b): legacyDoclingToCanonicalLayout() called
    // directly, exactly as computeCanonicalLayoutAndSummary() used to.
    const oldLayout = await legacyDoclingToCanonicalLayout(doclingRaw, {});
    const oldSummary = summarizeCanonicalLayout(oldLayout);

    // New chain (Phase 4b): via resolveCanonicalDocumentLayout({ doclingRaw }),
    // exactly as computeCanonicalLayoutAndSummary() now does.
    const resolution = await resolveCanonicalDocumentLayout({ doclingRaw: buildFixture() });
    assert(resolution.layout, "expected a resolved layout for a valid fixture");
    assert(resolution.validation?.valid, "expected the resolved layout to validate cleanly");
    const newSummary = summarizeCanonicalLayout(resolution.layout);

    assertEquals(resolution.source, "legacy_docling_raw");
    assertEquals(resolution.fidelity, "legacy_lossy");
    assertEquals(newSummary, oldSummary, "layout_summary");
    assertEquals(resolution.layout.content_hash, oldLayout.content_hash, "content_hash");
  });
}

// ── Edge cases from the Phase 4b adoption contract ───────────────────────────

Deno.test("side-write resolver adoption: missing doclingRaw resolves to no layout (source='none') -- what triggers the existing degrade-in-place path", async () => {
  const resolution = await resolveCanonicalDocumentLayout({ doclingRaw: null });
  assertEquals(resolution.source, "none");
  assertEquals(resolution.layout, null);
  // side-write.ts's early `if (!doclingRaw) return { summary: {}, contentHash: null }`
  // guard means this exact resolver call never actually happens for a truly
  // missing doclingRaw in production -- verified structurally here since
  // computeCanonicalLayoutAndSummary is private.
});

Deno.test("side-write resolver adoption: malformed (empty-object) doclingRaw fails validation (missing_content) -- fatal, not silently accepted", async () => {
  const resolution = await resolveCanonicalDocumentLayout({ doclingRaw: {} });
  assert(resolution.layout, "the legacy builder still synthesizes a single empty page, by design");
  assertFalse(resolution.validation.valid);
  assert(resolution.validation.errors.some((e) => e.code === "missing_content"));
});

Deno.test("side-write resolver adoption: content-free doclingRaw fails validation (missing_content) the same way -- this is what computeCanonicalLayoutAndSummary now throws into its own existing catch, degrading to { warnings: [...] } rather than a hollow 'successful' summary", async () => {
  const degenerate = { full_text: "", pages: [], text_blocks: [], tables: [] };
  const resolution = await resolveCanonicalDocumentLayout({ doclingRaw: degenerate });
  assert(resolution.layout);
  assertFalse(resolution.validation.valid);
  assert(resolution.validation.errors.some((e) => e.code === "missing_content"));
  assertEquals(resolution.layout.content_hash, null, "empty full_text never produces a real content_hash");
});

Deno.test("side-write resolver adoption: legacy_lossy fidelity is explicitly accepted -- the only fidelity reachable from this consumer's current input, not treated as a degradation", async () => {
  const resolution = await resolveCanonicalDocumentLayout({ doclingRaw: baseLeaseScaleDoclingRaw() });
  assertEquals(resolution.source, "legacy_docling_raw");
  assertEquals(resolution.fidelity, "legacy_lossy");
  assert(resolution.validation.valid);
});

Deno.test("side-write resolver adoption: warnings do not affect persistence behavior -- side-write.ts never branches on resolution.warnings contents", async () => {
  const source = await Deno.readTextFile(new URL("../_shared/extraction/document-intelligence-v3/side-write.ts", import.meta.url));
  assertFalse(/resolution\.warnings\.(some|find)\(/.test(source), "side-write.ts must never branch on resolution.warnings contents");
  assertFalse(/warning\.code\s*===/.test(source), "side-write.ts must never branch on an individual warning's code");
});

Deno.test("side-write resolver adoption: deterministic -- repeated calls with the same doclingRaw produce deep-equal resolutions", async () => {
  const doclingRaw = baseLeaseScaleDoclingRaw();
  const first = await resolveCanonicalDocumentLayout({ doclingRaw });
  const second = await resolveCanonicalDocumentLayout({ doclingRaw });
  assertEquals(first, second);
});

Deno.test("side-write resolver adoption: does not mutate the input doclingRaw object", async () => {
  const doclingRaw = camTableHeavyScaleDoclingRaw();
  const snapshot = JSON.parse(JSON.stringify(doclingRaw));
  await resolveCanonicalDocumentLayout({ doclingRaw });
  assertEquals(doclingRaw, snapshot);
});

Deno.test("side-write resolver adoption: no direct Azure adapter or legacy-builder import remains in side-write.ts (only doc-comment prose)", async () => {
  const source = await Deno.readTextFile(new URL("../_shared/extraction/document-intelligence-v3/side-write.ts", import.meta.url));
  const importLines = source.split("\n").filter((line) => line.trim().startsWith("import"));
  const importText = importLines.join("\n");
  assertFalse(importText.includes("buildCanonicalLayoutFromAzureLikeOutput"));
  assertFalse(importText.includes("legacyDoclingToCanonicalLayout"));
  assertFalse(importText.includes("azure-to-canonical-layout"));
  assert(importText.includes("canonical-layout-resolver"), "expected side-write.ts to import from canonical-layout-resolver.ts");
});
