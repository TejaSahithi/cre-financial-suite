import { describe, expect, it } from "vitest";
import { resolveLeaseField } from "../leaseFieldResolver";

describe("lease field resolver workflow precedence", () => {
  it("does not let top-level stale tenant date override workflow evidence", () => {
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

    expect(resolved.value).toBe("Mindful Tech Solutions Inc - Narendra Pydi");
    expect(resolved.sourcePath).toBe("lease.extraction_data.workflow_output.lease_fields");
  });

  it("rejects invalid workflow property fragments instead of showing them as normalized values", () => {
    const lease = {
      property_name: "Legacy Property",
      extraction_data: {
        workflow_output: {
          lease_fields: {
            property_name: {
              value: "Tenant has",
              source_page: 2,
              source_text: "at Tenant has park",
              validation_errors: ["property_name_not_specific"],
              requires_review: true,
            },
          },
        },
      },
    };

    const resolved = resolveLeaseField(lease, "property_name", { mode: "display" });

    expect(resolved.found).toBe(false);
    expect(resolved.value).toBeNull();
  });

  it("rejects bare numeric lease term when it has no source wording or derivation trace", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            lease_term: {
              value: 12,
              source_page: 1,
              source_text: "Tenant: January 9, 2024 224 Partners, LLC",
              extraction_status: "extracted",
            },
          },
        },
      },
    };

    const resolved = resolveLeaseField(lease, "lease_term", { mode: "display" });

    expect(resolved.found).toBe(false);
  });

  it("accepts derived annual rent only when lineage is present", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            annual_rent: {
              value: 16800,
              evidence_type: "derived",
              source_field_keys: ["monthly_rent"],
              derivation_trace: "annual_rent = monthly_rent (1400) x 12",
              source_text: "$1,400 per month",
              source_page: 1,
            },
          },
        },
      },
    };

    const resolved = resolveLeaseField(lease, "annual_rent", { mode: "display" });

    expect(resolved.value).toBe(16800);
    expect(resolved.derivationTrace).toContain("monthly_rent");
    expect(resolved.sourceFieldKeys).toContain("monthly_rent");
  });
});