import { describe, it, expect } from "vitest";
import { normalizeDynamicFindings } from "@/lib/leaseReviewFieldNormalizer";

describe("normalizeDynamicFindings", () => {
  it("collects findings from workflow_output.extracted_document_items", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            {
              item_id: "item-1",
              item_type: "co_tenancy_clause",
              label: "Co-Tenancy Clause",
              business_area: "legal_options",
              value: "Tenant may terminate if anchor tenant vacates.",
              source_text: "Tenant may terminate if anchor tenant vacates.",
              source_page: 12,
              confidence: 0.82,
              maps_to_existing_field: false,
              creates_dynamic_row: true,
            },
          ],
        },
      },
    };
    const rows = normalizeDynamicFindings(lease);
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("Co-Tenancy Clause");
    expect(rows[0].sourcePage).toBe(12);
    expect(rows[0].mapsToExistingField).toBe(false);
    expect(rows[0].createsDynamicRow).toBe(true);
  });

  it("excludes items already mapped to an existing standard field", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            { item_id: "mapped-1", item_type: "tenant_name", value: "Acme Inc", source_text: "Tenant: Acme Inc", maps_to_existing_field: true },
            { item_id: "unmapped-1", item_type: "quirky_clause", value: "Something unusual", source_text: "Something unusual clause text", maps_to_existing_field: false },
          ],
        },
      },
    };
    const rows = normalizeDynamicFindings(lease);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe("Something unusual");
  });

  it("returns an empty array, not a throw, when there is nothing to find", () => {
    expect(normalizeDynamicFindings({})).toEqual([]);
    expect(normalizeDynamicFindings(null)).toEqual([]);
  });

  it("additively merges vertex_fact_ledger dynamic_items when present", () => {
    const lease = {
      uploaded_files: {
        ui_review_payload: {
          metadata: {
            extractionDebug: {
              vertex_fact_ledger: {
                dynamic_items: [
                  {
                    item_id: "vfl-1",
                    item_type: "clause:governing_law",
                    label: "Governing Law",
                    source_text: "This lease is governed by the laws of Delaware.",
                    value: "Delaware",
                    maps_to_existing_field: false,
                    creates_dynamic_row: true,
                  },
                ],
              },
            },
          },
        },
      },
    };
    const rows = normalizeDynamicFindings(lease);
    expect(rows.some((r) => r.value === "Delaware")).toBe(true);
  });
});

describe("dynamic row tab routing", () => {
  it("routes parking findings to Parties & Premises and suppresses standard-field duplicates", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            { item_id: "parking", item_type: "reserved_parking_rights", label: "Reserved Parking", value: "Two reserved spaces", source_text: "Tenant has two reserved parking spaces.", maps_to_existing_field: false },
            { item_id: "rent", item_type: "monthly_rent", value: "$10,000", source_text: "Monthly rent is $10,000", maps_to_existing_field: false },
          ],
        },
      },
    };
    const rows = normalizeDynamicFindings(lease);
    expect(rows.some((row) => row.label === "Reserved Parking" && row.tabKey === "parties_premises")).toBe(true);
    expect(rows.some((row) => row.fieldKey === "monthly_rent" || row.category === "monthly_rent")).toBe(false);
  });
});
