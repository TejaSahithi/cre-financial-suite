// @ts-nocheck

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { azureAnalyzeResultToCanonicalLayout } from "../_shared/extraction/azure/azure-to-canonical-layout.ts";
import { buildCanonicalLayoutArtifact } from "../_shared/extraction/document-intelligence-v3/canonical-layout-artifact.ts";
import { computePageQuality, computeSinglePageQuality } from "../_shared/extraction/document-intelligence-v3/page-quality.ts";
import { reconcilePageCounts } from "../_shared/extraction/document-intelligence-v3/page-count-reconciliation.ts";
import { buildSectionHierarchy } from "../_shared/extraction/document-intelligence-v3/section-hierarchy.ts";
import { validateEvidenceAnchors } from "../_shared/extraction/document-intelligence-v3/evidence-anchor-validator.ts";
import { resolveDocumentIndex } from "../_shared/extraction/openai-fact-ledger/document-index-v3.ts";

function azureFixture() {
  return {
    content: "LEASE AGREEMENT\nRent Section\nTenant pays rent.",
    apiVersion: "2024-11-30",
    modelId: "prebuilt-layout",
    pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 0, length: 46 }] }],
    paragraphs: [
      { role: "title", content: "LEASE AGREEMENT", boundingRegions: [{ pageNumber: 1, polygon: [0, 0, 4, 0, 4, 1, 0, 1] }], spans: [{ offset: 0, length: 15 }] },
      { role: "sectionHeading", content: "Rent Section", boundingRegions: [{ pageNumber: 1, polygon: [0, 1, 4, 1, 4, 2, 0, 2] }], spans: [{ offset: 16, length: 12 }] },
      { content: "Tenant pays rent.", boundingRegions: [{ pageNumber: 1, polygon: [0, 2, 4, 2, 4, 3, 0, 3] }], spans: [{ offset: 29, length: 17 }] },
    ],
    tables: [],
  };
}

function pageQualityFixture(confidence: number | null | undefined) {
  const text = "Tenant pays base rent under this lease every month during the term.";
  return {
    page_number: 1,
    plain_text: text,
    page_width: 8.5,
    page_height: 11,
    blocks: [{
      block_id: "page-1-block-1",
      text,
      confidence,
      polygon: [0, 0, 4, 0, 4, 1, 0, 1],
    }],
    tables: [],
    figures: [],
    selection_marks: [],
  };
}

Deno.test("Release 3 canonical artifact hash is deterministic and metadata is attached", async () => {
  const layout = azureAnalyzeResultToCanonicalLayout(azureFixture(), { uploadedFileId: "uf-1", orgId: "org-1" });
  const first = await buildCanonicalLayoutArtifact({ layout, uploadedFileId: "uf-1", orgId: "org-1", generationId: "gen-1", generatedAt: "2026-07-21T00:00:00.000Z" });
  const second = await buildCanonicalLayoutArtifact({ layout, uploadedFileId: "uf-1", orgId: "org-1", generationId: "gen-1", generatedAt: "2026-07-22T00:00:00.000Z" });

  assertEquals(first.hash, second.hash);
  assertEquals(first.metadata.schemaVersion, "canonical-layout-v3");
  assertEquals(first.metadata.adapterVersion, "azure-native-v1");
  assertEquals((first.layout.metadata as any).canonical_layout_v3.canonicalLayoutHash, first.hash);
});

Deno.test("Release 3 persisted canonical layout wins in document-index resolution", async () => {
  const layout = (await buildCanonicalLayoutArtifact({
    layout: azureAnalyzeResultToCanonicalLayout(azureFixture(), { uploadedFileId: "uf-1", orgId: "org-1" }),
    uploadedFileId: "uf-1",
    orgId: "org-1",
  })).layout;

  const result = await resolveDocumentIndex({ full_text: "legacy text", pages: [{ page: 1, text: "legacy text" }], text_blocks: [] }, {
    strategy: "canonical_layout",
    canonicalLayout: layout,
  });

  assertEquals(result.indexSource, "canonical_layout");
  assert((result.index as any).canonicalLayout.text_projection.includes("Tenant pays rent"));
});

Deno.test("Release 3 page quality and reconciliation emit versioned page diagnostics", async () => {
  const layout = (await buildCanonicalLayoutArtifact({
    layout: azureAnalyzeResultToCanonicalLayout(azureFixture(), { uploadedFileId: "uf-1", orgId: "org-1" }),
    uploadedFileId: "uf-1",
    orgId: "org-1",
  })).layout;
  const pageQuality = computePageQuality(layout, { expectedPageCount: 2, azureNative: true });
  const reconciliation = reconcilePageCounts({ pdfMetadataPageCount: 2, azurePageCount: 1, canonicalLayout: layout, legacyParsedPageCount: 1, pageQuality, azureNative: true });

  assertEquals(pageQuality[0].status, "complete");
  assertEquals(pageQuality[1].status, "possibly_missing");
  assertEquals(reconciliation.agreementStatus, "disagree");
  assert(reconciliation.findings.some((f) => f.code === "page_count_mismatch"));
  assert(reconciliation.findings.some((f) => f.code === "missing_page" && f.pageNumber === 2));
});

Deno.test("Release 3 page quality ignores null confidence values", () => {
  const result = computeSinglePageQuality(pageQualityFixture(null), 1, true, true);

  assertEquals(result.averageConfidence, null);
  assertEquals(result.status, "complete");
  assert(!result.reasonCodes.includes("average_confidence_below_threshold"));
});

Deno.test("Release 3 page quality reports genuinely low numeric confidence", () => {
  const result = computeSinglePageQuality(pageQualityFixture(0.25), 1, true, true);

  assertEquals(result.averageConfidence, 0.25);
  assertEquals(result.status, "low_confidence");
  assert(result.reasonCodes.includes("average_confidence_below_threshold"));
});

Deno.test("Release 3 page quality accepts high numeric confidence", () => {
  const result = computeSinglePageQuality(pageQualityFixture(0.95), 1, true, true);

  assertEquals(result.averageConfidence, 0.95);
  assertEquals(result.status, "complete");
  assert(!result.reasonCodes.includes("average_confidence_below_threshold"));
});

Deno.test("Release 3 section hierarchy is deterministic", async () => {
  const layout = (await buildCanonicalLayoutArtifact({
    layout: azureAnalyzeResultToCanonicalLayout(azureFixture(), { uploadedFileId: "uf-1", orgId: "org-1" }),
    uploadedFileId: "uf-1",
    orgId: "org-1",
  })).layout;
  const hierarchy = buildSectionHierarchy(layout);

  assertEquals(hierarchy.version, "section-hierarchy-v1");
  assertEquals(hierarchy.sections.map((s) => s.headingText), ["LEASE AGREEMENT", "Rent Section"]);
  assertEquals(hierarchy.sections[1].parentSectionId, hierarchy.sections[0].sectionId);
});

Deno.test("Release 3 evidence anchor validation sanitizes bad anchors without dropping evidence", async () => {
  const layout = (await buildCanonicalLayoutArtifact({
    layout: azureAnalyzeResultToCanonicalLayout(azureFixture(), { uploadedFileId: "uf-1", orgId: "org-1" }),
    uploadedFileId: "uf-1",
    orgId: "org-1",
  })).layout;
  const result = validateEvidenceAnchors({
    layout,
    azureNative: true,
    evidence: [{
      claim_id: "claim-1",
      org_id: "org-1",
      document_id: null,
      uploaded_file_id: "uf-1",
      page: 99,
      source_text: "Tenant pays rent.",
      block_ids: ["page-1-block-2", "missing-block"],
      polygon: [0, Number.NaN, 1],
      support_type: "direct_quote",
    }],
  });

  assertEquals(result.sanitizedEvidence.length, 1);
  assertEquals(result.sanitizedEvidence[0].block_ids, ["page-1-block-2"]);
  assertEquals(result.sanitizedEvidence[0].polygon, []);
  assert(result.findings.some((f) => f.code === "orphan_block_id"));
  assert(result.findings.some((f) => f.code === "page_out_of_range"));
  assert(result.findings.some((f) => f.code === "page_mismatch"));
  assert(result.findings.some((f) => f.code === "invalid_polygon_coordinates"));
});