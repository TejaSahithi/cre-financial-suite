import { describe, expect, it } from "vitest";
import { getFieldDisplayProvenance, resolveLeaseField } from "../leaseFieldResolver";
import { buildDerivedFieldEvidence } from "../../components/lease-review/utils/dynamicFields";

// Micro-step 0 (pipeline-audit provenance) frontend tests. See
// LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16 for the design these
// verify. getFieldDisplayProvenance is purely additive — every test here
// also confirms resolveLeaseField's own resolved value is unaffected by
// calling the new diagnostic alongside it.

describe("getFieldDisplayProvenance (Micro-step 0)", () => {
  it("reports the winning fallback source and its position for a normal workflow-evidence field", () => {
    const lease = {
      tenant_name: "January 9, 2024",
      extraction_data: {
        workflow_output: {
          lease_fields: {
            tenant_name: {
              value: "Mindful Tech Solutions Inc - Narendra Pydi",
              source_page: 1,
              source_text: "Tenant: Mindful Tech Solutions Inc - Narendra Pydi",
              extraction_status: "extracted",
            },
          },
        },
      },
    };

    const resolved = resolveLeaseField(lease, "tenant_name", { mode: "display" });
    const provenance = getFieldDisplayProvenance(lease, "tenant_name", { mode: "display" });

    // Additive: calling the diagnostic must not change what resolveLeaseField itself returns.
    expect(resolved.value).toBe("Mindful Tech Solutions Inc - Narendra Pydi");
    expect(provenance.frontendResolutionSource).toBe("lease.extraction_data.workflow_output.lease_fields");
    expect(provenance.frontendFallbackIndex).toBe(0);
    expect(provenance.requestedFieldKey).toBe("tenant_name");
    expect(provenance.aliasUsed).toBe(false);
  });

  it("reports aliasUsed: true when the requested key has no raw data but a known alias does", () => {
    const lease = {
      extraction_data: {
        fields: {
          // Data stored under the alternate/alias key, not the requested one.
          responsibility_taxes: { value: "landlord_with_cap" },
        },
      },
    };

    const provenance = getFieldDisplayProvenance(lease, "tax_responsibility", { mode: "display" });

    expect(provenance.requestedFieldKey).toBe("tax_responsibility");
    expect(provenance.resolvedFieldKey).toBe("responsibility_taxes");
    expect(provenance.aliasUsed).toBe(true);
  });

  it("reports aliasUsed: false when the requested key itself has raw data", () => {
    const lease = {
      extraction_data: {
        fields: {
          tax_responsibility: { value: "tenant" },
        },
      },
    };

    const provenance = getFieldDisplayProvenance(lease, "tax_responsibility", { mode: "display" });

    expect(provenance.resolvedFieldKey).toBe("tax_responsibility");
    expect(provenance.aliasUsed).toBe(false);
  });

  it("surfaces activeGenerationId from the lease object and reports generationMatch as unknown (null), not a fabricated match", () => {
    const lease = {
      uploaded_files: { active_generation_id: "gen-123" },
      extraction_data: { fields: { tenant_name: { value: "Acme LLC" } } },
    };

    const provenance = getFieldDisplayProvenance(lease, "tenant_name", { mode: "display" });

    expect(provenance.activeGenerationId).toBe("gen-123");
    expect(provenance.payloadGenerationId).toBeNull();
    expect(provenance.generationMatch).toBeNull();
  });

  it("legacy-payload compatibility: works without throwing on a lease object with none of the new fields", () => {
    const legacyLease = { tenant_name: "Acme LLC" };
    expect(() => getFieldDisplayProvenance(legacyLease, "tenant_name", { mode: "display" })).not.toThrow();
    const provenance = getFieldDisplayProvenance(legacyLease, "tenant_name", { mode: "display" });
    expect(provenance.activeGenerationId).toBeNull();
    expect(provenance.generationMatch).toBeNull();
  });
});

describe("annual_rent derivation provenance (Micro-step 0, dynamicFields.js)", () => {
  it("preserves parent identity/derivation info without changing the computed value", () => {
    const lease = {
      uploaded_files: { active_generation_id: "gen-456" },
      extraction_data: {
        workflow_output: {
          lease_fields: {
            monthly_rent: {
              value: 174.55,
              source_page: 21,
              source_text: "The monthly cost to Tenant will be $174.55 and will be added to the monthly rent.",
              extraction_status: "extracted",
            },
          },
        },
      },
    };

    const evidence = buildDerivedFieldEvidence(lease, "annual_rent", null, {});

    assertDerivedAnnualRentShape(evidence);
  });
});

function assertDerivedAnnualRentShape(evidence) {
  expect(evidence).not.toBeNull();
  // The derivation itself (x12) is unchanged by this Micro-step — only
  // explained. 174.55 * 12 = 2094.6.
  expect(evidence.value).toBeCloseTo(2094.6, 2);
  expect(evidence.selectionProvenance).toBeTruthy();
  expect(evidence.selectionProvenance.pipelinePath).toBe("derived");
  expect(evidence.selectionProvenance.derivedFromField).toBe("monthly_rent");
  expect(evidence.selectionProvenance.derivedFromValue).toBe(174.55);
  expect(evidence.selectionProvenance.derivationExpression).toBe("monthly_rent * 12");
  expect(evidence.selectionProvenance.parentGenerationId).toBe("gen-456");
}
