import { describe, it, expect } from "vitest";
import { normalizeLeaseReviewData, normalizeStandardFields } from "@/lib/leaseReviewFieldNormalizer";

describe("leaseReviewFieldNormalizer smoke test", () => {
  it("does not throw on an empty lease", () => {
    expect(() => normalizeLeaseReviewData({})).not.toThrow();
  });

  it("does not throw on a bare lease with no extraction_data", () => {
    const result = normalizeLeaseReviewData({ id: "test-lease" });
    expect(result.standardFields.length).toBeGreaterThan(0);
    expect(result.dynamicFindings).toEqual([]);
    expect(result.clauseRecords).toEqual([]);
    expect(result.debugCounts.standard_fields_populated).toBe(0);
  });

  it("resolves a real value from extraction_data.fields", () => {
    const lease = {
      id: "test-lease",
      extraction_data: {
        fields: { tenant_name: "Acme Inc" },
        field_evidence: { tenant_name: { source_text: "Tenant: Acme Inc.", source_page: 1 } },
      },
    };
    const rows = normalizeStandardFields(lease);
    const tenantRow = rows.find((r) => r.canonicalKey === "tenant_name");
    expect(tenantRow.value).toBe("Acme Inc");
    expect(tenantRow.group).toBe("parties");
  });
});
