import { describe, it, expect } from "vitest";
import {
  normalizeLeaseReviewData,
  normalizeStandardFields,
  normalizeExpenseRuleRows,
  normalizeExpenseRuleFallback,
} from "@/lib/leaseReviewFieldNormalizer";

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

describe("normalizeStandardFields: grouping", () => {
  it("groups every returned field into one of the 17 standard groups", () => {
    const rows = normalizeStandardFields({ id: "test-lease" });
    const validGroups = new Set([
      "document_identity", "parties", "property_premises", "term_dates", "rent_charges",
      "expenses_recoveries", "cam_rules", "taxes", "insurance", "utilities",
      "repairs_maintenance", "legal_options", "critical_dates", "notices", "signatures",
      "budget_inputs", "approval_controls",
    ]);
    for (const row of rows) {
      expect(validGroups.has(row.group)).toBe(true);
    }
  });

  it("does not include computed-only fields (e.g. tenant_pro_rata_share) as their own row", () => {
    const rows = normalizeStandardFields({ id: "test-lease" });
    expect(rows.some((r) => r.canonicalKey === "tenant_pro_rata_share")).toBe(false);
  });
});

describe("CAM/Expense rule normalization from multiple payload shapes", () => {
  it("normalizes rich, already-loaded DB rule rows", () => {
    const rows = normalizeExpenseRuleRows([
      { expense_category: "cam", recoverable_from_tenant: true, recovery_method: "pro_rata_share", cap_percent: 5, admin_fee_percent: 15, source_page: 9, confidence_score: 0.88 },
    ]);
    expect(rows[0].category).toBe("cam");
    expect(rows[0].recoverable).toBe(true);
    expect(rows[0].cap).toBe(5);
  });

  it("falls back to workflow_output.expense_rules when no DB rows are loaded yet", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          expense_rules: [
            { expense_category: "real_estate_taxes", recoverable_flag: true, recovery_method: "base_year_excess", source_page: 3 },
          ],
        },
      },
    };
    const rows = normalizeExpenseRuleFallback(lease);
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("real_estate_taxes");
  });

  it("returns an empty array, not a throw, when there are no expense rules anywhere", () => {
    expect(normalizeExpenseRuleFallback({})).toEqual([]);
    expect(normalizeExpenseRuleRows(null)).toEqual([]);
  });
});

describe("Debug counts match the normalized UI rows", () => {
  it("standard_fields_populated in debugCounts equals the actual count of populated standardFields rows", () => {
    const lease = {
      id: "test-lease",
      extraction_data: {
        fields: { tenant_name: "Acme Inc", monthly_rent: 5000 },
        field_evidence: {
          tenant_name: { source_text: "Tenant: Acme Inc.", source_page: 1 },
          monthly_rent: { source_text: "Base Rent: $5,000/mo", source_page: 2 },
        },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    const actuallyPopulated = result.standardFields.filter(
      (f) => f.value !== null && f.value !== undefined && f.value !== "",
    ).length;
    expect(result.debugCounts.standard_fields_populated).toBe(actuallyPopulated);
    expect(result.debugCounts.clause_records_count).toBe(result.clauseRecords.length);
    expect(result.debugCounts.dynamic_findings_count).toBe(result.dynamicFindings.length);
  });
});

describe("Missing fields stay missing — no fake values invented", () => {
  it("a field with no data anywhere resolves to null value and status missing", () => {
    const rows = normalizeStandardFields({ id: "test-lease" });
    const buildingRsfRow = rows.find((r) => r.canonicalKey === "building_rsf");
    expect(buildingRsfRow.value).toBeNull();
    expect(buildingRsfRow.status).toBe("missing");
  });
});

describe("Old legacy payloads still render", () => {
  it("a pre-field-contract-task payload shape (no building_rsf/landlord_address/etc., no vertex_fact_ledger metadata) still normalizes cleanly", () => {
    const legacyLease = {
      id: "legacy-lease",
      extraction_data: {
        fields: {
          tenant_name: "Old Format Tenant LLC",
          monthly_rent: 4200,
          square_footage: 1800,
        },
        field_evidence: {
          tenant_name: { source_text: "Tenant: Old Format Tenant LLC", source_page: 1 },
        },
        workflow_output: {
          lease_fields: {
            tenant_name: { value: "Old Format Tenant LLC", source_page: 1, source_clause: "Tenant: Old Format Tenant LLC" },
          },
        },
      },
    };
    expect(() => normalizeLeaseReviewData(legacyLease)).not.toThrow();
    const result = normalizeLeaseReviewData(legacyLease);
    const tenantRow = result.standardFields.find((r) => r.canonicalKey === "tenant_name");
    expect(tenantRow.value).toBe("Old Format Tenant LLC");
    // The new gap fields (added in the field-contract-reconciliation task)
    // must gracefully resolve to missing, not throw or invent a value.
    const buildingRsfRow = result.standardFields.find((r) => r.canonicalKey === "building_rsf");
    expect(buildingRsfRow.value).toBeNull();
    expect(buildingRsfRow.status).toBe("missing");
  });
});
