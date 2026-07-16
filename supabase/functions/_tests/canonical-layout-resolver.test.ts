// @ts-nocheck
// Phase 3 unit tests for the canonical layout resolver
// (supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts).
// Pure-function tests only -- no DB, no network, no live Azure/Vertex call.
// Run: deno test --allow-env --allow-read --no-lock canonical-layout-resolver.test.ts

import { assert, assertEquals, assertFalse, assertNotStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveCanonicalDocumentLayout } from "../_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts";
import {
  CANONICAL_LAYOUT_SCHEMA_VERSION,
  legacyDoclingToCanonicalLayout,
  type CanonicalDocumentLayout,
} from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";
import { azureAnalyzeResultToCanonicalLayout } from "../_shared/extraction/azure/azure-to-canonical-layout.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Offsets are always derived programmatically (never hand-counted) so a
// fixture can never silently drift out of sync with its own spans.
function smallAzureAnalyzeResult(overrides: Record<string, unknown> = {}) {
  const title = "LEASE AGREEMENT";
  const body = "Base Rent is $5,000 per month.";
  const content = `${title}\n${body}`;
  const titleSpan = { offset: content.indexOf(title), length: title.length };
  const bodySpan = { offset: content.indexOf(body), length: body.length };

  return {
    apiVersion: "2024-11-30",
    modelId: "prebuilt-layout",
    content,
    pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 0, length: content.length }] }],
    paragraphs: [
      { role: "title", content: title, boundingRegions: [{ pageNumber: 1, polygon: [1, 1, 7, 1, 7, 1.3, 1, 1.3] }], spans: [titleSpan] },
      { content: body, boundingRegions: [{ pageNumber: 1, polygon: [1, 1.5, 7, 1.5, 7, 1.8, 1, 1.8] }], spans: [bodySpan] },
    ],
    tables: [],
    ...overrides,
  };
}

function smallDoclingRaw(overrides: Record<string, unknown> = {}) {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nLEASE AGREEMENT\n\nBase Rent is $5,000 per month.",
    page_count: 1,
    pages: [{ page: 1, text: "LEASE AGREEMENT\n\nBase Rent is $5,000 per month." }],
    text_blocks: [{ block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1 }],
    tables: [],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: { provider: "azure_document_intelligence", extraction_method: "azure_layout", api_version: "2024-11-30", page_markers_present: true, page_mapping_coverage: 1, raw_response_stored: false },
    ...overrides,
  };
}

async function buildValidCanonicalLayout(contentHash?: string): Promise<CanonicalDocumentLayout> {
  const layout = await legacyDoclingToCanonicalLayout(smallDoclingRaw(), contentHash ? { contentHash } : {});
  return layout;
}

// ── Provided canonical layout ────────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: provided valid canonical layout is used directly, source and fidelity reported", async () => {
  const layout = await buildValidCanonicalLayout();
  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: layout });

  assertEquals(result.source, "provided_canonical_layout");
  assertEquals(result.fidelity, "legacy_lossy");
  assertEquals(result.layout, layout);
  assert(result.validation.valid);
});

Deno.test("resolveCanonicalDocumentLayout: Azure-native provided layout reports lossless fidelity", async () => {
  const layout = azureAnalyzeResultToCanonicalLayout(smallAzureAnalyzeResult());
  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: layout });

  assertEquals(result.source, "provided_canonical_layout");
  assertEquals(result.fidelity, "lossless");
});

// ── Azure analyzeResult conversion ───────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: Azure analyzeResult alone is converted, validated, and reported lossless (Azure fidelity explicitly reported)", async () => {
  const result = await resolveCanonicalDocumentLayout({ azureAnalyzeResult: smallAzureAnalyzeResult() });

  assertEquals(result.source, "azure_analyze_result");
  assertEquals(result.fidelity, "lossless");
  assert(result.layout != null);
  assertEquals(result.layout.page_count, 1);
  assert(result.validation.valid);
});

// ── Legacy docling_raw conversion ────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: docling_raw alone is converted, validated, and reported legacy_lossy (legacy fidelity explicitly reported)", async () => {
  const result = await resolveCanonicalDocumentLayout({ doclingRaw: smallDoclingRaw() });

  assertEquals(result.source, "legacy_docling_raw");
  assertEquals(result.fidelity, "legacy_lossy");
  assert(result.layout != null);
  assert(result.validation.valid);
});

// ── No source supplied ───────────────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: no source supplied returns source='none', never throws", async () => {
  const result = await resolveCanonicalDocumentLayout({});
  assertEquals(result.source, "none");
  assertEquals(result.layout, null);
  assertEquals(result.fidelity, "unknown");
  assertEquals(result.validation, null);
  assertEquals(result.warnings, []);

  const resultNoArgs = await resolveCanonicalDocumentLayout();
  assertEquals(resultNoArgs.source, "none");
});

// ── Invalid canonical layout ──────────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: structurally invalid canonical layout is not silently accepted -- falls back to Azure result, fatal errors preserved in warnings", async () => {
  const valid = await buildValidCanonicalLayout();
  const invalid: CanonicalDocumentLayout = {
    ...valid,
    pages: [
      { ...valid.pages[0], page_number: 1 },
      { ...valid.pages[0], page_number: 1 }, // duplicate page_number -> fatal
    ],
  };

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: invalid, azureAnalyzeResult: smallAzureAnalyzeResult() });

  assertEquals(result.source, "azure_analyze_result");
  assert(result.warnings.some((w) => w.code === "canonical_layout_structurally_invalid" && w.severity === "fatal"));
});

Deno.test("resolveCanonicalDocumentLayout: structurally invalid canonical layout with no fallback source is still returned, fully flagged (validation errors preserved, data never discarded)", async () => {
  const valid = await buildValidCanonicalLayout();
  const invalid: CanonicalDocumentLayout = {
    ...valid,
    pages: [
      { ...valid.pages[0], page_number: 1 },
      { ...valid.pages[0], page_number: 1 },
    ],
  };

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: invalid });

  assertEquals(result.source, "provided_canonical_layout");
  assertEquals(result.layout, invalid);
  assertFalse(result.validation.valid);
  assert(result.validation.errors.some((e) => e.code === "duplicate_page_number"));
  assert(result.warnings.some((w) => w.code === "canonical_layout_structurally_invalid"));
});

// ── Schema-version handling (Task C) ─────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: unsupported OLD schema version is not silently accepted -- falls back to docling_raw", async () => {
  const valid = await buildValidCanonicalLayout();
  const tooOld: CanonicalDocumentLayout = { ...valid, schema_version: 0 };

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: tooOld, doclingRaw: smallDoclingRaw() });

  assertEquals(result.source, "legacy_docling_raw");
  assert(result.warnings.some((w) => w.code === "canonical_layout_schema_version_too_old" && w.severity === "fatal"));
});

Deno.test("resolveCanonicalDocumentLayout: unsupported FUTURE schema version is not silently accepted -- falls back to docling_raw", async () => {
  const valid = await buildValidCanonicalLayout();
  const tooNew: CanonicalDocumentLayout = { ...valid, schema_version: 999 };

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: tooNew, doclingRaw: smallDoclingRaw() });

  assertEquals(result.source, "legacy_docling_raw");
  assert(result.warnings.some((w) => w.code === "canonical_layout_schema_version_too_new" && w.severity === "fatal"));
});

Deno.test("resolveCanonicalDocumentLayout: missing historical schema_version is accepted only with unknown fidelity and an explicit warning", async () => {
  const valid = await buildValidCanonicalLayout();
  const historical: CanonicalDocumentLayout = { ...valid, schema_version: undefined };

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: historical });

  assertEquals(result.source, "provided_canonical_layout");
  assertEquals(result.fidelity, "unknown"); // not "legacy_lossy" even though layout.provider says so -- Task C policy
  assert(result.warnings.some((w) => w.code === "canonical_layout_schema_version_missing" && w.severity === "recoverable"));
});

Deno.test("resolveCanonicalDocumentLayout: current schema_version is accepted without a schema warning", async () => {
  const valid = await buildValidCanonicalLayout();
  assertEquals(valid.schema_version, CANONICAL_LAYOUT_SCHEMA_VERSION);

  const result = await resolveCanonicalDocumentLayout({ canonicalLayout: valid });
  assertFalse(result.warnings.some((w) => w.code.startsWith("canonical_layout_schema_version")));
});

// ── Conflict detection (Task B.5) ────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: canonical + Azure same-source agreement (matching content_hash) -- canonical wins, no recomputation, no conflict warning", async () => {
  const layout = await buildValidCanonicalLayout("sha256:matching-hash");

  const result = await resolveCanonicalDocumentLayout({
    canonicalLayout: layout,
    azureAnalyzeResult: smallAzureAnalyzeResult(),
    sourceMetadata: { sourcePayloadHash: "sha256:matching-hash" },
  });

  assertEquals(result.source, "provided_canonical_layout");
  assertEquals(result.layout, layout);
  assertFalse(result.warnings.some((w) => w.code.includes("conflict") || w.code.includes("superseded") || w.code.includes("undetermined")));
});

Deno.test("resolveCanonicalDocumentLayout: canonical + Azure conflicting source hashes -- newer Azure result wins, stale canonical never silently preferred", async () => {
  const layout = await buildValidCanonicalLayout("sha256:old-hash");

  const result = await resolveCanonicalDocumentLayout({
    canonicalLayout: layout,
    azureAnalyzeResult: smallAzureAnalyzeResult(),
    sourceMetadata: { sourcePayloadHash: "sha256:different-new-hash" },
  });

  assertEquals(result.source, "azure_analyze_result");
  assert(result.warnings.some((w) => w.code === "canonical_layout_superseded_by_newer_azure_result"));
  assertNotStrictEquals(result.layout, layout);
});

Deno.test("resolveCanonicalDocumentLayout: canonical older than Azure based on generated_at metadata -- newer Azure result wins", async () => {
  const layout = await buildValidCanonicalLayout();
  layout.metadata = { ...layout.metadata, generated_at: "2026-01-01T00:00:00.000Z" };

  const result = await resolveCanonicalDocumentLayout({
    canonicalLayout: layout,
    azureAnalyzeResult: smallAzureAnalyzeResult(),
    sourceMetadata: { generatedAt: "2026-06-01T00:00:00.000Z" },
  });

  assertEquals(result.source, "azure_analyze_result");
  assert(result.warnings.some((w) => w.code === "canonical_layout_superseded_by_newer_azure_result"));
});

Deno.test("resolveCanonicalDocumentLayout: missing metadata where authority cannot be established -- Azure used as safer default, loudly flagged as undetermined (not silently guessed)", async () => {
  const layout = await buildValidCanonicalLayout(); // content_hash present but caller supplies none to compare
  layout.content_hash = null; // ensure no hash signal at all
  layout.metadata = { ...layout.metadata, generated_at: undefined };

  const result = await resolveCanonicalDocumentLayout({
    canonicalLayout: layout,
    azureAnalyzeResult: smallAzureAnalyzeResult(),
    // no sourceMetadata at all
  });

  assertEquals(result.source, "azure_analyze_result");
  assert(result.warnings.some((w) => w.code === "canonical_azure_authority_undetermined" && w.severity === "recoverable"));
});

// ── Validation errors preserved ──────────────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: validation errors on the winning (Azure) layout are preserved in the result, not swallowed", async () => {
  // A malformed Azure result whose paragraph span is out of range against content -> fatal invalid_span from the validator.
  const malformed = smallAzureAnalyzeResult();
  malformed.paragraphs[0].spans = [{ offset: 0, length: 99999 }];

  const result = await resolveCanonicalDocumentLayout({ azureAnalyzeResult: malformed });

  assertFalse(result.validation.valid);
  assert(result.validation.errors.some((e) => e.code === "invalid_span"));
});

// ── Determinism, immutability, no leakage ────────────────────────────────────

Deno.test("resolveCanonicalDocumentLayout: deterministic -- repeated calls with the same input produce deep-equal results", async () => {
  const input = { azureAnalyzeResult: smallAzureAnalyzeResult() };
  const first = await resolveCanonicalDocumentLayout(input);
  const second = await resolveCanonicalDocumentLayout(input);
  assertEquals(first, second);
});

Deno.test("resolveCanonicalDocumentLayout: does not mutate any input object", async () => {
  const canonicalLayout = await buildValidCanonicalLayout("sha256:immutable-check");
  const azureAnalyzeResult = smallAzureAnalyzeResult();
  const doclingRaw = smallDoclingRaw();
  const sourceMetadata = { sourcePayloadHash: "sha256:immutable-check", generatedAt: "2026-01-01T00:00:00.000Z" };

  const canonicalSnapshot = JSON.parse(JSON.stringify(canonicalLayout));
  const azureSnapshot = JSON.parse(JSON.stringify(azureAnalyzeResult));
  const doclingSnapshot = JSON.parse(JSON.stringify(doclingRaw));
  const metadataSnapshot = JSON.parse(JSON.stringify(sourceMetadata));

  await resolveCanonicalDocumentLayout({ canonicalLayout, azureAnalyzeResult, doclingRaw, sourceMetadata });

  assertEquals(canonicalLayout, canonicalSnapshot);
  assertEquals(azureAnalyzeResult, azureSnapshot);
  assertEquals(doclingRaw, doclingSnapshot);
  assertEquals(sourceMetadata, metadataSnapshot);
});

Deno.test("resolveCanonicalDocumentLayout: no provider-specific (Azure) raw field names leak into the result", async () => {
  const result = await resolveCanonicalDocumentLayout({ azureAnalyzeResult: smallAzureAnalyzeResult() });
  const serialized = JSON.stringify(result);
  for (const azureKey of ['"boundingRegions"', '"pageNumber"', '"rowIndex"', '"columnIndex"']) {
    assertFalse(serialized.includes(azureKey), `resolver result must not contain the raw Azure key ${azureKey}`);
  }
});
