// @ts-nocheck

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildSemanticFieldSearchResponse, buildSemanticSearchRecords, searchSemanticRecords } from "../_shared/extraction/document-semantics/semantic-field-search.ts";

Deno.test("Release 6 semantic field search ranks exact field keys above text matches", () => {
  const records = buildSemanticSearchRecords({
    uploadedFileId: "uf-1",
    documentFamilyId: "family-1",
    fields: {
      monthly_rent: { label: "Monthly Rent", value: "$10,000", status: "resolved", authoritativeSource: "canonical_projection" },
      expiration_date: { label: "Expiration Date", value: "2030-12-31", status: "resolved", authoritativeSource: "canonical_projection" },
    },
    definitions: [{ id: "d1", termNormalized: "rent", termDisplay: "Rent", definitionText: "Base Rent and Additional Rent", scopeKey: "1.1", sourcePageNumbers: [1], evidenceIds: [], definitionStatus: "resolved" }],
  });
  const results = searchSemanticRecords({ uploadedFileId: "uf-1", query: "monthly rent", limit: 5 }, records);
  assertEquals(results[0].key, "monthly_rent");
  assertEquals(results[0].score, 100);
});

Deno.test("Release 6 semantic field search filters by entity type and status", () => {
  const records = buildSemanticSearchRecords({ uploadedFileId: "uf-1", fields: { tenant_name: { label: "Tenant Name", value: "Acme", status: "resolved" } }, definitions: [{ id: "d1", termNormalized: "tenant", termDisplay: "Tenant", definitionText: "Acme LLC", scopeKey: null, sourcePageNumbers: [1], evidenceIds: [], definitionStatus: "resolved" }] });
  const results = searchSemanticRecords({ uploadedFileId: "uf-1", query: "tenant", entityTypes: ["definition"], statuses: ["resolved"] }, records);
  assertEquals(results.length, 1);
  assertEquals(results[0].entityType, "definition");
});

Deno.test("Release 6 field search endpoint response is deterministic", () => {
  const response = buildSemanticFieldSearchResponse({ uploadedFileId: "uf-1", query: "tenant", limit: 10 }, [{ entityType: "field", key: "tenant_name", label: "Tenant Name", matchedText: "Acme", uploadedFileId: "uf-1", documentFamilyId: null, runId: null, generationId: null, fieldKey: "tenant_name", sectionKey: null, pageNumber: 1, status: "resolved", source: "canonical_projection", score: 0, evidenceIds: [], reasonCodes: [] }]);
  assertEquals(response.resultCount, 1);
  assertEquals(response.diagnostics.schemaVersion, "document-semantic-search-response-v1");
});