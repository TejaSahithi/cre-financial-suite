import { describe, expect, it } from "vitest";
import {
  buildCompactLeaseDocument,
  compactDocumentEvidenceMap,
} from "../../../supabase/functions/_shared/extraction/whole-document-llm/compact-document.ts";
import {
  buildWholeDocumentJsonSchema,
  buildWholeDocumentSystemPrompt,
} from "../../../supabase/functions/_shared/extraction/whole-document-llm/whole-document-schema.ts";

describe("whole-document LLM experiment", () => {
  it("preserves complete page and table evidence without the legacy 3K page cap", () => {
    const longPageText = `Lease page content ${"x".repeat(5_000)}`;
    const compact = buildCompactLeaseDocument({
      extraction_method: "azure_layout",
      page_count: 2,
      pages: [
        { page: 1, text: longPageText },
        { page: 2, text: "Exhibit B rent schedule" },
      ],
      text_blocks: [],
      tables: [{
        table_index: 3,
        page: 2,
        headers: ["Year", "Monthly Rent"],
        rows: [["1", "$5,000"], ["2", "$5,250"]],
      }],
      fields: [],
    });

    expect(compact.nodes[0].text).toBe(longPageText);
    expect(compact.nodes[0].text.length).toBeGreaterThan(3_000);
    expect(compact.tables[0].rows[1].id).toBe("table:3:row:1");

    const evidence = compactDocumentEvidenceMap(compact);
    expect(evidence.get("page:2")?.text).toContain("Exhibit B");
    expect(evidence.get("table:3:row:0")?.text).toBe("1\t$5,000");
    expect(evidence.get("table:3:row:0")?.page).toBe(2);
  });

  it("reuses a full compact artifact persisted before parser caps", () => {
    const original = buildCompactLeaseDocument({
      page_count: 1,
      pages: [{ page: 1, text: "Complete source" }],
      text_blocks: [],
      tables: [],
      fields: [],
    }, "azure_full_layout");

    const resolved = buildCompactLeaseDocument({
      page_count: 1,
      pages: [{ page: 1, text: "Capped source" }],
      text_blocks: [],
      tables: [],
      fields: [],
      _whole_document_llm_compact: original,
    });

    expect(resolved.source).toBe("persisted_compact");
    expect(resolved.nodes[0].text).toBe("Complete source");
  });

  it("uses a bounded claim-array schema instead of one nested object per lease field", () => {
    const fields = [
      ["tenant_name", { type: "string", labels: [], description: "Tenant legal entity" }],
      ["monthly_rent", { type: "number", labels: [], description: "Monthly base rent" }],
    ] as any;
    const schema = buildWholeDocumentJsonSchema(fields) as any;

    expect(schema.required).toEqual(["claims", "notStatedFieldKeys", "dynamicFindings"]);
    expect(schema.properties.claims.type).toBe("array");
    expect(schema.properties.claims.items.properties.fieldKey.enum).toEqual([
      "tenant_name",
      "monthly_rent",
    ]);
    expect(schema.properties.notStatedFieldKeys.items.enum).toEqual([
      "tenant_name",
      "monthly_rent",
    ]);
    expect(schema.properties.dynamicFindings.type).toBe("array");
    expect(schema.properties.dynamicFindings.items.properties.suggestedFieldKey.enum).toBeUndefined();
    expect(schema.properties).not.toHaveProperty("tenant_name");
  });

  it("requires a professional multi-pass review and unrestricted grounded dynamic discovery", () => {
    const fields = [
      ["tenant_name", { type: "string", labels: [], description: "Tenant legal entity" }],
    ] as any;
    const prompt = buildWholeDocumentSystemPrompt(fields);

    expect(prompt).toContain("more than forty years");
    expect(prompt).toContain("Build and apply the document's defined-term dictionary");
    expect(prompt).toContain("second, independent completeness sweep");
    expect(prompt).toContain("dynamicFindings is mandatory and may contain ANY NUMBER");
    expect(prompt).toContain("Do not place a fact in a fixed field merely because similar words appear");
    expect(prompt).toContain("ONLY status found may contain a non-null value");
    expect(prompt).toContain("Do not confuse monthly base rent");
    expect(prompt).toContain("commencement_date and start_date are the same lease-admin concept");
    expect(prompt).toContain("expiration_date and end_date are the same lease-admin concept");
    expect(prompt).toContain("Do not convert \"year to year\"");
    expect(prompt).toContain("Full-service/gross means certain costs may be included in base rent");
    expect(prompt).toContain("cam_amount is a numeric dollar amount only");
    expect(prompt).toContain("Every operational");
  });
});
