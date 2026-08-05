import { describe, it, expect } from "vitest";
import {
  normalizeLeaseReviewData,
  normalizeStandardFields,
  normalizeExpenseRuleRows,
  normalizeExpenseRuleFallback,
  isSignatureDateSourcedFromLeaseReference,
  resolveLeaseReviewExtractionMode,
  normalizeClauseRecords,
  normalizeDynamicFindings,
  buildReadinessSummary,
} from "@/lib/leaseReviewFieldNormalizer";
import { isMarkupArtifactValue, EXTRACTION_MODES, REVIEW_STATUSES } from "@/lib/leaseReviewSchema";

describe("leaseReviewFieldNormalizer smoke test", () => {
  it("does not throw on an empty lease", () => {
    expect(() => normalizeLeaseReviewData({})).not.toThrow();
  });


  it("does not treat optional needs-review rows as approval blockers", () => {
    const standardFields = [
      { canonicalKey: "tenant_name", rowType: "standard", value: "Mindful Tech Solutions, Inc.", status: "auto_populated", evidenceVerified: true, tabKey: "summary" },
      { canonicalKey: "broker_name", rowType: "standard", value: "Brownlee Realty, LLC", status: "needs_review", evidenceVerified: true, tabKey: "summary" },
    ];
    const summary = buildReadinessSummary({
      standardFields,
      dynamicFindings: [],
      expenseRules: [],
      camRules: [],
      clauseRecords: [],
      criticalDates: [],
      approvalBlockers: { budgetBlockers: [], camBlockers: [] },
      tabs: { summary: standardFields },
      currentReviewPolicy: { requiredFieldKeys: ["tenant_name"] },
    });

    expect(summary.approvalReadiness).toBe("ready");
    expect(summary.needsReviewFields).toEqual([]);
    expect(summary.tabSummaries.find((tab) => tab.key === "summary").needsReview).toBe(0);
  });

  it("lets alternate canonical fields satisfy required readiness inputs", () => {
    const standardFields = [
      { canonicalKey: "commencement_date", rowType: "standard", value: "2024-02-01", status: "auto_populated", evidenceVerified: true, tabKey: "dates_term" },
    ];
    const summary = buildReadinessSummary({
      standardFields,
      dynamicFindings: [],
      expenseRules: [],
      camRules: [],
      clauseRecords: [],
      criticalDates: [],
      approvalBlockers: { budgetBlockers: [], camBlockers: [] },
      tabs: { dates_term: standardFields },
      currentReviewPolicy: { requiredFieldKeys: ["start_date"] },
    });

    expect(summary.missingRequiredFields).not.toContain("start_date");
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

  it("does not mistake a recurring month/day anniversary for the final lease expiration", () => {
    const lease = {
      id: "recurring-expiration-lease",
      extraction_data: {
        fields: {
          commencement_date: "2024-02-01",
          expiration_date: null,
        },
        field_evidence: {
          commencement_date: {
            value: "2024-02-01",
            source_text: "(b) Commencement Date: February 1, 2024",
            source_page: 1,
            extraction_status: "extracted",
          },
          expiration_date: {
            value: null,
            source_text: "(c) Expiration Date: January 31st of each year",
            source_page: 1,
            extraction_status: "not_found",
          },
        },
      },
    };

    const rows = normalizeStandardFields(lease);
    const expiration = rows.find((r) => r.canonicalKey === "expiration_date");
    const termMonths = rows.find((r) => r.canonicalKey === "lease_term_months");

    expect(expiration.value).toBeNull();
    expect(expiration.status).toBe("not_found");
    expect(termMonths.value).toBeNull();
    expect(termMonths.status).toBe("not_found");
  });

  it("calculates the final expiration from commencement plus the independently stated term", () => {
    const lease = {
      id: "five-year-recurring-expiration-lease",
      extraction_data: {
        fields: {
          commencement_date: "2024-02-01",
          expiration_date: null,
          lease_term_months: 60,
        },
        field_evidence: {
          commencement_date: {
            value: "2024-02-01",
            source_text: "Commencement Date: February 1, 2024",
            source_page: 1,
            extraction_status: "extracted",
          },
          expiration_date: {
            value: null,
            source_text: "Expiration Date: January 31st of each year",
            source_page: 1,
            extraction_status: "not_found",
          },
          lease_term_months: {
            value: 60,
            source_text: "The initial Term is sixty (60) months.",
            source_page: 2,
            extraction_status: "extracted",
          },
        },
      },
    };

    const rows = normalizeStandardFields(lease);
    const expiration = rows.find((r) => r.canonicalKey === "expiration_date");

    expect(expiration.value).toBe("2029-01-31");
    expect(expiration.status).toBe("needs_review");
    expect(expiration.extractionMode).toBe(EXTRACTION_MODES.CALCULATED);
    expect(expiration.sourcePage).toBe(2);
    expect(expiration.validationMessage).toMatch(/stated initial lease term/i);
  });

  it("hides lease-derived expense rules before approval unless diagnostic fallback rows are requested", () => {
    const lease = {
      id: "pending-downstream-lease",
      abstract_status: "review_required",
      extraction_data: {
        fields: {
          commencement_date: "2024-02-01",
          expiration_date: "2029-01-31",
        },
        workflow_output: {
          expense_rules: [
            {
              rule_key: "tax-rule",
              expense_category: "real_estate_taxes",
              normalized_rule: "Tenant reimburses real estate taxes",
            },
            {
              rule_key: "cam-rule",
              expense_category: "common_area_maintenance",
              normalized_rule: "Tenant reimburses CAM",
            },
          ],
        },
      },
    };

    const result = normalizeLeaseReviewData(lease);

    expect(result.downstreamApproved).toBe(false);
    expect(result.expenseRules).toEqual([]);
    expect(result.camRules).toEqual([]);
    expect(result.tabs.expenses_recoveries.some((row) => row.rowType === "expense_rule")).toBe(false);
    expect(result.tabs.cam_rules.some((row) => row.rowType === "cam_rule")).toBe(false);
    expect(result.materialTerms.some((row) => row.materialSource === "expense_rule")).toBe(false);
    expect(result.materialTerms.some((row) => row.materialSource === "cam_rule")).toBe(false);
    expect(result.criticalDates).toEqual([]);
    expect(result.tabs.critical_dates).toEqual([]);
    expect(result.tabs.budget_preview).toEqual([]);

    const diagnostic = normalizeLeaseReviewData(lease, { allowDiagnosticExpenseRuleFallbacks: true });
    expect(diagnostic.expenseRules).toHaveLength(1);
    expect(diagnostic.camRules).toHaveLength(1);
  });

  it("derives monthly rent from annual rent with source lineage when monthly rent is missing", () => {
    const lease = {
      id: "annual-only-rent-lease",
      extraction_data: {
        fields: {
          annual_rent: 25200,
          monthly_rent: null,
        },
        field_evidence: {
          annual_rent: {
            value: 25200,
            source_text: "Annual Rent: $25,200",
            source_page: 3,
            extraction_status: "extracted",
          },
        },
      },
    };

    const rows = normalizeStandardFields(lease);
    const monthlyRent = rows.find((r) => r.canonicalKey === "monthly_rent");

    expect(monthlyRent.value).toBe(2100);
    expect(monthlyRent.extractionMode).toBe(EXTRACTION_MODES.CALCULATED);
    expect(monthlyRent.sourcePage).toBe(3);
    expect(monthlyRent.sourceText).toBe("Annual Rent: $25,200");
    expect(monthlyRent.validationMessage).toMatch(/annual rent divided by 12/i);
  });

  it("keeps consent fields when cited transfer language semantically supports the value", () => {
    const lease = {
      id: "consent-lease",
      extraction_data: {
        fields: {
          landlord_consent_for_transfer: "prior written landlord consent required",
        },
        field_evidence: {
          landlord_consent_for_transfer: {
            value: "prior written landlord consent required",
            source_text: "Tenant shall not make any Transfer without the prior consent of Landlord, which Landlord shall not unreasonably withhold or delay.",
            source_page: 7,
            extraction_status: "extracted",
          },
        },
      },
    };

    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_consent_for_transfer");
    expect(row.value).toBe("prior written landlord consent required");
    expect(row.validationMessage).toBeFalsy();
  });

  it("rejects invalid typed standard values in grouped Lease Review rows", () => {
    const lease = {
      id: "invalid-standard-value-lease",
      extraction_data: {
        fields: {
          expiration_date: "2024-02-30",
        },
        field_evidence: {
          expiration_date: {
            value: "2024-02-30",
            source_text: "Expiration Date: February 30, 2024",
            source_page: 1,
            extraction_status: "extracted",
          },
        },
      },
    };

    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "expiration_date");
    expect(row.value).toBeNull();
    expect(row.validation_errors).toContain("expiration_date_failed_validation");
    expect(row.validationMessage).toMatch(/valid calendar date/i);
  });

  it("marks separate gross lease CAM economics as display-only not applicable instead of missing", () => {
    const lease = {
      id: "gross-lease",
      extraction_data: {
        fields: {
          lease_type: "gross",
          cam_amount: null,
        },
        field_evidence: {
          lease_type: {
            value: "gross",
            source_text: "This is a Gross Lease.",
            source_page: 5,
            extraction_status: "extracted",
          },
        },
      },
    };

    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "cam_amount");
    expect(row.value).toBeNull();
    expect(row.displayValue).toMatch(/N\/A/i);
    expect(row.status).toBe("not_applicable");
    expect(row.sourceText).toBe("This is a Gross Lease.");
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
    // must gracefully resolve to no value, not throw or invent one. Status
    // is "not_found" (Release 1), not "missing" -- extraction_data.fields
    // is present (the extractor ran, per resolveExtractionStatus's
    // extractorRan check), it just didn't find building_rsf in this legacy
    // payload shape. "missing" now means the extractor never ran at all.
    const buildingRsfRow = result.standardFields.find((r) => r.canonicalKey === "building_rsf");
    expect(buildingRsfRow.value).toBeNull();
    expect(buildingRsfRow.status).toBe("not_found");
  });
});

describe("enterprise lease abstract row model", () => {
  it("places monthly_rent only in Rent & Charges as editable and Budget Preview as read-only", () => {
    const result = normalizeLeaseReviewData({ abstract_status: "approved", extraction_data: { fields: { monthly_rent: 27865 } } });
    expect(result.tabs.rent_charges.some((row) => row.canonicalKey === "monthly_rent" && row.rowType === "standard" && row.editable)).toBe(true);
    expect(result.tabs.budget_preview.some((row) => row.canonicalKey === "monthly_rent" && row.rowType === "read_only_reference" && row.editable === false)).toBe(true);
    const editableAppearances = Object.values(result.tabs).flat().filter((row) => row.canonicalKey === "monthly_rent" && row.editable).length;
    expect(editableAppearances).toBe(1);
  });

  it("splits expense and CAM rule rows into their related tabs", () => {
    const result = normalizeLeaseReviewData({
      abstract_status: "approved",
      extraction_data: {
        workflow_output: {
          expense_rules: [
            { expense_category: "real_estate_taxes", requires_review: true, source_text: "Tenant shall pay taxes." },
            { expense_category: "common_area_maintenance", requires_review: true, source_text: "Tenant shall pay CAM subject to cap." },
          ],
        },
      },
    }, { allowDiagnosticExpenseRuleFallbacks: true });
    expect(result.tabs.expenses_recoveries.some((row) => row.rowType === "expense_rule" && row.category === "real_estate_taxes")).toBe(true);
    expect(result.tabs.cam_rules.some((row) => row.rowType === "cam_rule" && row.category === "common_area_maintenance")).toBe(true);
    expect(result.debugCounts.expense_rules_count).toBe(1);
    expect(result.debugCounts.cam_rules_count).toBe(1);
  });

  it("normalizes confidence scores from 0-1 and 0-100 scales", () => {
    const result = normalizeLeaseReviewData({
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            { item_id: "d1", item_type: "parking_right", label: "Parking Right", value: "Two spaces", source_text: "Tenant has two spaces.", confidence: 0.96 },
            { item_id: "d2", item_type: "special_notice", label: "Special Notice", value: "Copy lender", source_text: "Copy lender on notices.", confidence: 96 },
          ],
        },
      },
    });
    const rows = Object.values(result.tabs).flat().filter((row) => row.rowType === "dynamic");
    expect(rows.map((row) => row.confidencePercent).sort()).toEqual([96, 96]);
  });
});

describe("Phase 39: signature date evidence-integrity", () => {
  it("reproduces the bug: tenant_signature_date sourced from original-lease-reference text is not accepted", () => {
    const lease = {
      extraction_data: {
        fields: { tenant_signature_date: "2018-02-01" },
        field_evidence: {
          tenant_signature_date: {
            source_text: "Tenant, entered into that certain Lease dated February\n1, 2018",
            source_page: 1,
          },
        },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "tenant_signature_date");
    expect(row.value).toBe("2018-02-01");
    expect(row.evidenceVerified).toBe(false);
    expect(row.status).not.toBe("auto_populated");
    expect(row.status).toBe("needs_review");
    expect(row.validationMessage).toMatch(/original lease/i);
  });

  it("reproduces the bug: landlord_signature_date sourced from original-lease-reference text is not accepted", () => {
    const lease = {
      extraction_data: {
        fields: { landlord_signature_date: "2018-02-01" },
        field_evidence: {
          landlord_signature_date: {
            source_text: "Landlord and Assignor, as Tenant, entered into that certain Lease dated February\n1, 2018",
            source_page: 1,
          },
        },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_signature_date");
    expect(row.evidenceVerified).toBe(false);
    expect(row.status).toBe("needs_review");
  });

  it("keeps a genuinely valid signature date accepted when source text describes actual execution", () => {
    const sourceText = "IN WITNESS WHEREOF, Tenant has executed this Agreement as of November 7, 2023.";
    expect(isSignatureDateSourcedFromLeaseReference(sourceText)).toBe(false);

    const lease = {
      extraction_data: {
        fields: { tenant_signature_date: "2023-11-07" },
        field_evidence: { tenant_signature_date: { source_text: sourceText, source_page: 3 } },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "tenant_signature_date");
    expect(row.value).toBe("2023-11-07");
  });

  it("isSignatureDateSourcedFromLeaseReference: direct unit coverage", () => {
    expect(isSignatureDateSourcedFromLeaseReference("entered into that certain Lease dated February 1, 2018")).toBe(true);
    expect(isSignatureDateSourcedFromLeaseReference("pursuant to that certain Lease dated January 1, 2020")).toBe(true);
    expect(isSignatureDateSourcedFromLeaseReference("IN WITNESS WHEREOF, executed as of November 7, 2023.")).toBe(false);
    expect(isSignatureDateSourcedFromLeaseReference(null)).toBe(false);
    expect(isSignatureDateSourcedFromLeaseReference("")).toBe(false);
    expect(isSignatureDateSourcedFromLeaseReference("Base Rent shall be $5,000 per month.")).toBe(false);
  });
});

describe("Phase 39: invalid markup value sanitizer", () => {
  it("reproduces the bug: landlord_name '<figure>' is rejected, not shown as an accepted value", () => {
    const lease = {
      extraction_data: {
        fields: { landlord_name: "<figure>" },
        field_evidence: { landlord_name: { source_text: "LANDLORD:\n\n<figure>", source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_name");
    expect(row.value).toBeNull();
    // Release 1: "not_found", not "missing" -- extraction_data.fields is
    // present (the extractor ran), it just produced a rejected/nulled
    // value for this field. "missing" now means the extractor never ran.
    expect(row.status).toBe("not_found");
    expect(row.evidenceVerified).toBe(false);
    expect(row.invalidValueRejected).toBe(true);
    expect(row.validationMessage).toMatch(/layout\/markup artifact/i);
  });

  it("keeps a normal landlord_name value accepted when evidence supports it", () => {
    const lease = {
      extraction_data: {
        fields: { landlord_name: "Montvue, LLC" },
        field_evidence: {
          landlord_name: { source_text: "LANDLORD: Montvue, LLC, a Tennessee limited liability company", source_page: 1 },
        },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_name");
    expect(row.value).toBe("Montvue, LLC");
    expect(row.invalidValueRejected).toBe(false);
  });

  it("isMarkupArtifactValue: rejects bare layout tags generically, not real text", () => {
    for (const artifact of ["<figure>", "<table>", "<tr>", "<td>", "</figure>"]) {
      expect(isMarkupArtifactValue(artifact)).toBe(true);
    }
    expect(isMarkupArtifactValue("Montvue, LLC")).toBe(false);
    expect(isMarkupArtifactValue(null)).toBe(false);
    expect(isMarkupArtifactValue("")).toBe(false);
  });

  it("does not create a new approval blocker for the assignment profile as a side effect of rejecting the invalid value", () => {
    const lease = {
      extraction_data: {
        workflow_output: { document_profile: { documentType: "assignment" } },
        fields: {
          assignee_name: "New Tenant LLC",
          assignment_effective_date: "2026-01-15",
          landlord_name: "<figure>",
        },
        field_evidence: {
          assignee_name: { source_text: "assignee_name: New Tenant LLC", source_page: 1 },
          assignment_effective_date: { source_text: "assignment_effective_date: 2026-01-15", source_page: 1 },
          landlord_name: { source_text: "LANDLORD:\n\n<figure>", source_page: 1 },
        },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    const landlordRow = result.standardFields.find((r) => r.canonicalKey === "landlord_name");

    // landlord_name already has "signal" (source text) so it's still in the
    // assignment profile's requiredFieldKeys - confirm that, then confirm
    // rejecting its garbage value doesn't turn it into a NEW blocker.
    expect(result.currentReviewPolicy.requiredFieldKeys).toContain("landlord_name");
    expect(landlordRow.value).toBeNull();
    expect(landlordRow.invalidValueRejected).toBe(true);
    expect(result.approvalBlockers.missingFields).not.toContain("landlord_name");
    expect(result.readinessSummary.missingRequiredFields).not.toContain("landlord_name");
  });
});

describe("Phase 40: extraction mode resolver", () => {
  it("explicit requires a real value AND valid, page-anchored source evidence - not just a value", () => {
    const lease = {
      extraction_data: {
        fields: { assignee_name: "NARENDRA PYDI" },
        field_evidence: { assignee_name: { source_text: 'NARENDRA PYDI, a resident of the state ("Assignee").', source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "assignee_name");
    expect(row.value).toBe("NARENDRA PYDI");
    expect(row.extractionMode).toBe(EXTRACTION_MODES.EXPLICIT);
  });

  it("does not claim explicit for a value with no source evidence at all", () => {
    const lease = { extraction_data: { fields: { assignee_name: "NARENDRA PYDI" }, field_evidence: {} } };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "assignee_name");
    expect(row.value).toBeNull();
    expect(row.extractionMode).not.toBe(EXTRACTION_MODES.EXPLICIT);
    expect(row.extractionMode).toBe(EXTRACTION_MODES.UNKNOWN);
  });

  it("rejected markup-artifact rows (landlord_name '<figure>') are unknown, never explicit", () => {
    const lease = {
      extraction_data: {
        fields: { landlord_name: "<figure>" },
        field_evidence: { landlord_name: { source_text: "LANDLORD:\n\n<figure>", source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_name");
    expect(row.invalidValueRejected).toBe(true);
    expect(row.extractionMode).toBe(EXTRACTION_MODES.UNKNOWN);
  });

  it("signature dates sourced from the original lease date are unknown, never explicit", () => {
    const lease = {
      extraction_data: {
        fields: { tenant_signature_date: "2018-02-01" },
        field_evidence: {
          tenant_signature_date: {
            source_text: "Tenant, entered into that certain Lease dated February\n1, 2018",
            source_page: 1,
          },
        },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "tenant_signature_date");
    expect(row.evidenceVerified).toBe(false);
    expect(row.extractionMode).toBe(EXTRACTION_MODES.UNKNOWN);
  });

  it("reviewer-edited values resolve to reviewer_entered", () => {
    const lease = {
      extraction_data: {
        fields: { tenant_name: "Old Value LLC" },
        field_evidence: { tenant_name: { source_text: "Tenant: Old Value LLC", source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease, {
      fieldReviews: { tenant_name: { status: REVIEW_STATUSES.EDITED, value: "New Value LLC" } },
    }).find((r) => r.canonicalKey === "tenant_name");
    expect(row.extractionMode).toBe(EXTRACTION_MODES.REVIEWER_ENTERED);
  });

  it("manual-required review status resolves to manual", () => {
    const lease = {
      extraction_data: {
        fields: { tenant_name: "Some Value LLC" },
        field_evidence: { tenant_name: { source_text: "Tenant: Some Value LLC", source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease, {
      fieldReviews: { tenant_name: { status: REVIEW_STATUSES.MANUAL_REQUIRED } },
    }).find((r) => r.canonicalKey === "tenant_name");
    expect(row.extractionMode).toBe(EXTRACTION_MODES.MANUAL);
  });

  it("backend-tagged calculated/manual extraction statuses resolve accordingly", () => {
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, extractionStatus: "calculated", evidenceVerified: false }),
    ).toBe(EXTRACTION_MODES.CALCULATED);
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, extractionStatus: "manual_required", evidenceVerified: false }),
    ).toBe(EXTRACTION_MODES.MANUAL);
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, extractionStatus: "inferred", evidenceVerified: true }),
    ).toBe(EXTRACTION_MODES.INFERRED);
  });

  it("unknown is the safe default when the mode cannot be determined - never fabricated", () => {
    expect(resolveLeaseReviewExtractionMode()).toBe(EXTRACTION_MODES.UNKNOWN);
    expect(resolveLeaseReviewExtractionMode({ hasValue: false })).toBe(EXTRACTION_MODES.UNKNOWN);
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, evidenceVerified: false, extractionStatus: "extracted" }),
    ).toBe(EXTRACTION_MODES.UNKNOWN);
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, invalidValueRejected: true, evidenceVerified: true }),
    ).toBe(EXTRACTION_MODES.UNKNOWN);
    expect(
      resolveLeaseReviewExtractionMode({ hasValue: true, evidenceOverrideReason: "demoted", evidenceVerified: true }),
    ).toBe(EXTRACTION_MODES.UNKNOWN);
  });

  it("non-standard row types (dynamic findings, clause records, expense/CAM rules) default to unknown, not a guessed mode", () => {
    const lease = {
      abstract_status: "approved",
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            { item_id: "d1", item_type: "parking_right", label: "Parking Right", value: "Two spaces", source_text: "Tenant has two spaces.", confidence: 0.96 },
          ],
          expense_rules: [
            { expense_category: "real_estate_taxes", requires_review: true, source_text: "Tenant shall pay taxes." },
          ],
        },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    expect(result.dynamicFindings.every((row) => row.extractionMode === EXTRACTION_MODES.UNKNOWN)).toBe(true);
    expect(result.expenseRules.every((row) => row.extractionMode === EXTRACTION_MODES.UNKNOWN)).toBe(true);
    const clauseRows = result.tabs.clause_records || [];
    if (clauseRows.length > 0) {
      expect(clauseRows.every((row) => row.extractionMode === EXTRACTION_MODES.UNKNOWN)).toBe(true);
    }
  });

  it("critical dates and budget preview reference rows inherit the standard field's real extraction mode (not unknown by default)", () => {
    const lease = {
      abstract_status: "approved",
      extraction_data: {
        fields: { commencement_date: "2025-01-01" },
        field_evidence: { commencement_date: { source_text: "Commencement Date: January 1, 2025", source_page: 1 } },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    const criticalDateRow = result.criticalDates.find((r) => r.canonicalKey === "commencement_date");
    expect(criticalDateRow.extractionMode).toBe(EXTRACTION_MODES.EXPLICIT);
  });
});

describe("Phase 44A-Fix: landlord_consent evidence integrity (fixture regression)", () => {
  it("landlord_consent becomes evidenceVerified true only because the real source text genuinely supports it", () => {
    const lease = {
      extraction_data: {
        fields: { landlord_consent: true },
        field_evidence: {
          landlord_consent: {
            source_text:
              "Landlord hereby consents to the assignment and assumption of the Lease as set forth herein, subject to the terms and conditions of this Agreement.",
            source_page: 1,
          },
        },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "landlord_consent");
    expect(row.value).toBe(true);
    expect(row.evidenceVerified).toBe(true);
    expect(row.extractionMode).toBe(EXTRACTION_MODES.EXPLICIT);
  });

  it("landlord_consent remains advisory, not a hard blocker, once evidence-verified", () => {
    const lease = {
      extraction_data: {
        workflow_output: { document_profile: { documentType: "assignment" } },
        fields: {
          assignee_name: "New Tenant LLC",
          assignment_effective_date: "2026-01-15",
          landlord_consent: true,
        },
        field_evidence: {
          assignee_name: { source_text: "assignee_name: New Tenant LLC", source_page: 1 },
          assignment_effective_date: { source_text: "assignment_effective_date: 2026-01-15", source_page: 1 },
          landlord_consent: {
            source_text: "Landlord hereby consents to the assignment and assumption of the Lease.",
            source_page: 1,
          },
        },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    const landlordConsentRow = result.standardFields.find((r) => r.canonicalKey === "landlord_consent");
    expect(landlordConsentRow.evidenceVerified).toBe(true);
    expect(result.currentReviewPolicy.requiredFieldKeys).not.toContain("landlord_consent");
    expect(result.approvalBlockers.missingFields).not.toContain("landlord_consent");
    expect(result.currentReviewPolicy.advisoryGaps.map((g) => g.key)).toContain("landlord_consent_assignment_advisory");
  });
});

describe("Phase 44A-Fix: Clause Records content-based dedup", () => {
  it("dedupes the same field appearing in two payload maps, keeping the page-bearing copy", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            landlord_consent: { value: true, source_page: 1, source_text: "Landlord hereby consents to the assignment." },
          },
        },
        fields: {
          landlord_consent: { value: true, source_text: "Landlord hereby consents to the assignment." },
        },
      },
    };
    const rows = normalizeClauseRecords(lease).filter((r) => r.title === "Landlord Consent");
    expect(rows.length).toBe(1);
    expect(rows[0].sourcePage).toBe(1);
  });

  it("merges a truncated copy with its fuller counterpart, keeping the longer text", () => {
    const fullText =
      "DDDD ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE by and among MONTVUE LLC, a Tennessee limited liability company (Landlord), RYSHER INC, a Tennessee corporation (Assignor), and NARENDRA PYDI, a resident of (Assignee).";
    const truncatedText =
      "DDDD ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE by and among MONTVUE LLC, a Tennessee limited liability company (Landlord)";
    const lease = {
      extraction_data: {
        workflow_output: { lease_fields: { tenant_name: { value: "X", source_page: 1, source_text: truncatedText } } },
        fields: { tenant_name: { value: "X", source_text: fullText } },
      },
    };
    const rows = normalizeClauseRecords(lease).filter((r) => r.title === "Tenant Name");
    expect(rows.length).toBe(1);
    expect(rows[0].summary.length).toBeGreaterThan(truncatedText.length);
  });

  it("does not merge two same-label rows whose text is genuinely different (not a prefix relationship)", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            assignment_provisions: { value: "A", source_page: 1, source_text: "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE" },
          },
        },
        fields: {
          assignment_provisions: {
            value: "B",
            source_text: "Assignor hereby assigns all of its right, title and interest in the Lease to Assignee.",
          },
        },
      },
    };
    const rows = normalizeClauseRecords(lease).filter((r) => r.title === "Assignment Provisions");
    expect(rows.length).toBe(2);
  });

  it("does not merge distinct clauses just because they mention the same party/date", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            assignment_effective_date: {
              value: "2023-11-07",
              source_page: 1,
              source_text: "This Agreement is entered into as of November 7, 2023.",
            },
            tenant_signatory_name: {
              value: "Doug Fleming",
              source_page: 3,
              source_text: "By: Doug Fleming, signed November 7, 2023.",
            },
          },
        },
      },
    };
    const rows = normalizeClauseRecords(lease);
    expect(rows.length).toBe(2);
  });
});

describe("Phase 44A-Fix: Clause Records rejected-evidence handling", () => {
  it("suppresses a rejected markup artifact from ever becoming a clause row", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: { landlord_name: { value: "<figure>", source_page: 1, source_text: "LANDLORD:\n\n<figure>" } },
        },
      },
    };
    const rows = normalizeClauseRecords(lease);
    expect(rows.some((r) => r.title === "Landlord Name")).toBe(false);
  });

  it("suppresses a clause row whose text is exactly a bare markup tag", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: { some_field: { value: "<table>", source_page: 1, source_text: "<table>" } },
        },
      },
    };
    const rows = normalizeClauseRecords(lease);
    expect(rows.some((r) => r.summary === "<table>")).toBe(false);
  });

  it("flags a clause row sourced from the original lease date as needs_review, not a clean pending summary", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            tenant_signature_date: {
              value: "2018-02-01",
              source_page: 1,
              source_text: "Tenant, entered into that certain Lease dated February 1, 2018",
            },
          },
        },
      },
    };
    const rows = normalizeClauseRecords(lease).filter((r) => r.title === "Tenant Signature Date");
    expect(rows.length).toBe(1);
    expect(rows[0].reviewStatus).toBe("needs_review");
  });

  it("does not flag an ordinary clause as needs_review", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            security_deposit: {
              value: 8575,
              source_page: 2,
              source_text: "Assignee shall pay to Landlord, as a Security Deposit, an amount equal to $8,575.00.",
            },
          },
        },
      },
    };
    const rows = normalizeClauseRecords(lease).filter((r) => r.title === "Security Deposit");
    expect(rows.length).toBe(1);
    expect(rows[0].reviewStatus).toBe("pending");
  });
});

describe("Phase 46: base-lease required-field alias resolution", () => {
  function baseLeaseFixture(standardFields) {
    const uploadedFile = {
      document_subtype: "base_lease",
      ui_review_payload: {
        document_subtype: "base_lease",
        records: [{ standard_fields: standardFields, row_index: 0 }],
      },
    };
    return {
      id: "phase46-base-lease-fixture",
      org_id: "1307dd95-e7c5-4e08-833e-749444e8f4c8",
      status: "draft",
      uploaded_files: uploadedFile,
      uploaded_file: uploadedFile,
    };
  }

  it("premises_address resolves via property_address when populated + evidence-verified", () => {
    const lease = baseLeaseFixture([
      { field_key: "property_address", value: "224 S Peters Road Knoxville, TN 37923", source: "llm", status: "auto_populated", evidence: { source_page: 1, source_text: "located at 224 S Peters Road Knoxville, TN 37923" } },
    ]);
    const result = normalizeLeaseReviewData(lease);
    const row = result.standardFields.find((r) => r.canonicalKey === "property_address");
    expect(row.evidenceVerified).toBe(true);
    expect(result.approvalBlockers.missingFields).not.toContain("premises_address");
    expect(result.readinessSummary.missingRequiredFields).not.toContain("premises_address");
  });

  it("premises_use resolves via permitted_use when populated + evidence-verified", () => {
    const lease = baseLeaseFixture([
      { field_key: "permitted_use", value: "IT work", source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "Permitted Use: IT work" } },
    ]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).not.toContain("premises_use");
  });

  it("lease_term resolves via lease_term_months when populated", () => {
    const lease = baseLeaseFixture([
      { field_key: "lease_term_months", value: 60, source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "a term of sixty (60) months" } },
    ]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).not.toContain("lease_term");
  });

  it("missing canonical field still creates the legacy blocker (property_address absent)", () => {
    const lease = baseLeaseFixture([
      { field_key: "tenant_name", value: "Acme Inc", source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "Tenant: Acme Inc" } },
    ]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).toContain("premises_address");
    expect(result.readinessSummary.missingRequiredFields).toContain("premises_address");
  });

  it("a rejected/markup-artifact alias row (value null) does not satisfy the requirement", () => {
    const lease = baseLeaseFixture([
      { field_key: "permitted_use", value: null, source: "system", status: "needs_review", evidence: null, validation_errors: ["Rejected: extracted value contained HTML/markup fragments"] },
    ]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).toContain("premises_use");
  });

  it("a needs_review alias row with no meaningful value and no invalidValueRejected flag does not satisfy the requirement", () => {
    const lease = baseLeaseFixture([
      { field_key: "property_address", value: null, source: "system", status: "needs_review", evidence: null },
    ]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).toContain("premises_address");
  });

  it("with no matching row at all (canonical field never extracted), the legacy alias still blocks", () => {
    const lease = baseLeaseFixture([]);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).toContain("premises_address");
  });

  it("Phase 39 invalidValueRejected carve-out (markup-artifact value on the canonical field) still applies through the alias path exactly as it did for direct-key lookups - no new leniency, no new blocker", () => {
    // Real Phase 39/45 shape: property_address's extracted value was a bare
    // HTML tag artifact ("</td>") - normalizeStandardFields rejects it
    // (invalidValueRejected: true, value -> null) rather than treating it
    // as a real value. The pre-Phase-39 behavior for a required field in
    // this state was NOT to add a new blocker (see hasRowValue's
    // invalidValueRejected carve-out) - this proves the alias-aware lookup
    // preserves that exact behavior for the legacy key name too.
    const lease = {
      id: "phase46-invalid-value-carveout",
      extraction_data: {
        workflow_output: { document_profile: { documentType: "base_lease" } },
        fields: { property_address: "</td>" },
        field_evidence: { property_address: { source_text: "2. Landlord:</td>", source_page: null } },
      },
    };
    const propertyAddressRow = normalizeStandardFields(lease).find((r) => r.canonicalKey === "property_address");
    expect(propertyAddressRow.invalidValueRejected).toBe(true);
    expect(propertyAddressRow.value).toBeNull();

    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields).not.toContain("premises_address");
  });

  it("real Phase 45 base-lease fixture: missingFields drops from 7 to 6 (only premises_address removed)", () => {
    const standardFields = [
      { field_key: "tenant_name", value: "Mindful Tech Solutions Inc", source: "rule", status: "auto_populated", evidence: { source_page: 16, source_text: "TENANT: Mindful Tech Solutions Inc." } },
      { field_key: "landlord_name", value: null, source: "system", status: "needs_review", evidence: null, validation_errors: ["Rejected: extracted value contained HTML/markup fragments"] },
      { field_key: "property_address", value: "224 S Peters Road Knoxville, TN 37923", source: "llm", status: "auto_populated", evidence: { source_page: 1, source_text: "located at 224 S Peters Road Knoxville, TN 37923" } },
      { field_key: "permitted_use", value: null, source: "system", status: "needs_review", evidence: null, validation_errors: ["Rejected: extracted value contained HTML/markup fragments"] },
      { field_key: "square_footage", value: 1110, source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "approximately 1,110 rentable square feet" } },
      { field_key: "lease_date", value: null, source: "system", status: "missing", evidence: null },
      { field_key: "lease_term_months", value: null, source: "system", status: "missing", evidence: null },
      { field_key: "commencement_date", value: null, source: "system", status: "missing", evidence: null },
      { field_key: "expiration_date", value: null, source: "system", status: "missing", evidence: null },
      { field_key: "monthly_rent", value: 1400, source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "$1,400 per month" } },
      { field_key: "security_deposit", value: 1400, source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "Security Deposit $1,400" } },
      { field_key: "lease_type", value: "gross", source: "rule", status: "auto_populated", evidence: { source_page: 1, source_text: "Full Service" } },
    ];
    const lease = baseLeaseFixture(standardFields);
    const result = normalizeLeaseReviewData(lease);
    expect(result.approvalBlockers.missingFields.slice().sort()).toEqual(
      ["commencement_date", "expiration_date", "landlord_name", "lease_date", "lease_term", "premises_use"].sort()
    );
    expect(result.approvalBlockers.missingFields).not.toContain("premises_address");
  });
});

describe("Phase 46: assignment document behavior is unaffected by the alias fix", () => {
  it("real Phase 44A-Fix assignment fixture: blocker set stays exactly [assignor_name]", () => {
    const lease = {
      id: "phase46-assignment-regression",
      extraction_data: {
        workflow_output: { document_profile: { documentType: "assignment" } },
        fields: {
          tenant_name: "NARENDRA PYDI",
          assignee_name: "NARENDRA PYDI",
          assignment_effective_date: "2023-11-07",
          landlord_consent: true,
          assumption_scope: "Assignee hereby assumes the obligations",
          assignment_provisions: "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE",
          all_other_terms_remain_same: "All other terms of the Lease shall remain the same.",
          tenant_signatory_name: "Doug Fleming",
          // assignor_name intentionally has no resolvable value below - only
          // weak clause-level signal (matching the real approved document,
          // where "Assignor Name" has a clause row but never resolves to a
          // clean field value) - the one real, expected blocker.
        },
        field_evidence: {
          tenant_name: { source_text: "MONTVUE, LLC ... RYSHER, INC. ... NARENDRA PYDI", source_page: 1 },
          assignee_name: { source_text: "NARENDRA PYDI, a resident of (\"Assignee\").", source_page: 1 },
          assignment_effective_date: { source_text: "entered into as of the 7th day of November, 2023", source_page: 1 },
          landlord_consent: { source_text: "Landlord hereby consents to the assignment and assumption of the Lease.", source_page: 1 },
          assumption_scope: { source_text: "Assignee hereby assumes the obligations", source_page: 1 },
          assignment_provisions: { source_text: "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE", source_page: 1 },
          all_other_terms_remain_same: { source_text: "All other terms of the Lease shall remain the same.", source_page: 1 },
          tenant_signatory_name: { source_text: "By: Doug Fleming", source_page: null },
          // Weak signal only (source_page, no resolvable value) - gives
          // assignor_name "signal" so it enters the assignment profile's
          // required-key set (ASSIGNMENT_REQUIRED_IF_PRESENT_KEYS) without
          // ever satisfying it, exactly like the real approved document.
          assignor_name: { source_text: "Assignor and Assignee desire to enter into this Agreement to, among", source_page: 1 },
        },
      },
    };
    const result = normalizeLeaseReviewData(lease);
    expect(result.currentReviewPolicy.profile).toBe("assignment");
    expect(result.approvalBlockers.missingFields).toEqual(["assignor_name"]);
    expect(result.approvalBlockers.budgetBlockers).toEqual([]);
    expect(result.approvalBlockers.camBlockers).toEqual([]);
    const advisoryKeys = result.currentReviewPolicy.advisoryGaps.map((g) => g.key);
    expect(advisoryKeys).toContain("original_lease_missing");
    expect(advisoryKeys).toContain("tenant_name_assignment_advisory");
    expect(advisoryKeys).toContain("landlord_consent_assignment_advisory");
  });
});


describe("Phase 50: Clause Records quality filtering", () => {
  function baseLeaseWithLeaseFields(leaseFields) {
    return {
      document_subtype: "base_lease",
      extraction_data: {
        workflow_output: {
          document_profile: { documentType: "base_lease" },
          lease_fields: leaseFields,
        },
      },
    };
  }

  it("does not duplicate standard field facts as base-lease Clause Records", () => {
    const rows = normalizeClauseRecords(baseLeaseWithLeaseFields({
      tenant_name: { value: "Cress Family Restaurants, LLC", source_page: 12, source_text: "TENANT: CRESS FAMILY RESTAURANTS, LLC" },
      property_address: { value: "3826 MAUpin DR", source_text: "Address: 3826 MAUpin DR" },
    }));
    expect(rows).toEqual([]);
  });

  it("does not duplicate Expense/CAM rule facts as Clause Records", () => {
    const rows = normalizeClauseRecords(baseLeaseWithLeaseFields({
      responsibility_taxes: { value: "Tenant", source_page: 2, source_text: "Real Estate Taxes, Insurance Premiums and Common Area Maintenance Expenses: Tenant shall remit to Landlord its Pro-Rata Share." },
      admin_fee_pct: { value: 5, source_page: 3, source_text: "a reasonable sum not to exceed five percent of Rent collected to cover the management costs relative to the Common Areas" },
    }));
    expect(rows).toEqual([]);
  });

  it("does not duplicate Rent Addendum schedule facts as Clause Records", () => {
    const rows = normalizeClauseRecords(baseLeaseWithLeaseFields({
      monthly_rent: { value: 6004, source_page: 14, source_text: "RENT ADDENDUM Months-3-12 $ 24.00 $ 6,004.00 Months 13 - 24 $ 24.48 $ 6,124.08" },
    }));
    expect(rows).toEqual([]);
  });

  it("does not duplicate Security Deposit fallback facts as Clause Records", () => {
    const rows = normalizeClauseRecords(baseLeaseWithLeaseFields({
      security_deposit: { value: 15535.36, source_page: 16, source_text: "SECURITY DEPOSIT ADDENDUM for a total of Fifteen Thousand, Five Hundred Thirty Five and 30/100 Dollars ($15,535.36)" },
    }));
    expect(rows).toEqual([]);
  });

  it("filters generic legal boilerplate from base-lease Clause Records", () => {
    const rows = normalizeClauseRecords({
      document_subtype: "base_lease",
      extraction_data: {
        workflow_output: {
          document_profile: { documentType: "base_lease" },
          clause_records: [
            { item_type: "miscellaneous", label: "Generic", source_text: "Notwithstanding the foregoing", source_page: 5 },
          ],
        },
      },
    });
    expect(rows).toEqual([]);
  });

  it("retains a distinct high-value legal summary with reviewer status", () => {
    const rows = normalizeClauseRecords(baseLeaseWithLeaseFields({
      default_cure_period: { value: "30 days", source_page: 10, source_text: "Failure by Tenant to perform any covenant for thirty (30) days after notice shall constitute a default and Landlord may pursue remedies." },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Default Cure Period");
    expect(rows[0].reviewStatus).toBe("needs_review");
  });

  it("keeps assignment Clause Records behavior unchanged", () => {
    const rows = normalizeClauseRecords({
      document_subtype: "assignment",
      extraction_data: {
        workflow_output: {
          document_profile: { documentType: "assignment" },
          lease_fields: {
            landlord_consent: { value: true, source_page: 1, source_text: "Landlord hereby consents to the assignment and assumption of the Lease." },
          },
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Landlord Consent");
  });
});


describe("Phase 48B: no-provider CAM-heavy base lease fallbacks", () => {
  const premisesPage = {
    page: 1,
    text: 'Premises: Landlord hereby leases Premises to Tenant, and Tenant leases and accepts certain Premises (Building 9, Suites 3 and 4) and further described as 12350 South Northshore , Knoxville, TN 37922, located in a shopping center known as The Markets at Choto in Knoxville, Tennessee, the Demised Premises herein being approximately Three thousand and two (3,002) rentable square feet.',
  };
  const rentAddendumPage = {
    page: 14,
    text: 'RENT ADDENDUM The monthly Minimum Rent payable by Tenant hereunder shall be as follows: Months-3-12 $ 24.00 $ 6,004.00 Months 13 - 24 $ 24.48 $ 6,124.08 Months-25-36 $ 24.97 $ 6,246.56 Minimum Rent is exclusive of all Common Area Maintenance (CAM) Charges due by Tenant. CAM estimate for 2021 is $5.25 per leasable square foot.',
  };
  const securityDepositPage = {
    page: 16,
    text: 'SECURITY DEPOSIT ADDENDUM As security for the prompt and punctual performance of all obligations required to be performed hereunder by Tenant, Tenant shall, upon Lease execution, deposit with Landlord the total of what equals the sum of the third month rent of the base term plus CAM and the eighty-sixth month rent of the base term plus CAM, or Twelve Thousand, Nine Hundred Eight and 60/100 Dollars ($12,908.60) in Base Rent and Two Thousand, Six Hundred Twenty Six and 76/100 Dollars ($2,626.76) in CAM, for a total of Fifteen Thousand, Five Hundred Thirty Five and 30/100 Dollars ($15,535.36), which shall be held as a security deposit.',
  };
  const expensePage = {
    page: 2,
    text: 'Pro-rata Share of Real Estate Taxes, Insurance Premiums and Common Area Maintenance Expenses: Tenant shall remit to Landlord as Additional Rent its Pro-Rata Share, as hereinafter defined, multiplied by the real estate taxes, insurance premiums, and common area maintenance expenses incurred by the Landlord in connection with the operation of the Shopping Center. Tenant shall pay its Pro-Rata Share of the above expenses within twenty (20) days after receipt of a bill therefor.',
  };
  const adminPage = {
    page: 3,
    text: 'The term common area maintenance expenses shall mean the total cost and expense incurred in operating, maintaining, cleaning and repairing the Common Areas and a reasonable sum (not to exceed five percent of Rent collected) to cover the management costs relative to the operation of the Common Areas and the Shopping Center.',
  };

  const camHeavyLease = (overrides = {}) => ({
    abstract_status: 'approved',
    document_subtype: 'base_lease',
    extraction_data: {
      workflow_output: { document_profile: { documentType: 'base_lease' } },
      fields: {
        tenant_name: 'CRESS FAMILY RESTAURANTS, LLC',
        landlord_name: 'MARKETS AT CHOTO, LLC',
        property_address: '3826 MAUpin DR',
        admin_fee_pct: 5,
        ...(overrides.fields || {}),
      },
      field_evidence: {
        tenant_name: { source_text: 'Tenant: CRESS FAMILY RESTAURANTS, LLC', source_page: 12 },
        landlord_name: { source_text: 'Landlord: MARKETS AT CHOTO, LLC', source_page: 11 },
        property_address: { source_text: 'Tenant Contact Information Address: 3826 MAUpin DR', source_page: null },
        admin_fee_pct: { source_text: adminPage.text, source_page: 3 },
        ...(overrides.field_evidence || {}),
      },
      ...(overrides.extraction_data || {}),
    },
    uploaded_file: {
      docling_raw: { pages: overrides.pages || [premisesPage, expensePage, adminPage, rentAddendumPage, securityDepositPage] },
    },
  });

  it('does not let a tenant/contact address satisfy property_address by default', () => {
    const result = normalizeLeaseReviewData(camHeavyLease());
    const row = result.standardFields.find((r) => r.canonicalKey === 'property_address');
    expect(row.value).toBeNull();
    expect(['missing', 'needs_review']).toContain(row.status);
    expect(row.sourceProvider).not.toBe('no_provider_payload_fallback');
    expect(row.validationMessage).toMatch(/does not support/i);
  });

  it('can still run the old no-provider premises fallback when explicitly opted in for diagnostics', () => {
    const result = normalizeLeaseReviewData(camHeavyLease(), { allowNoProviderCoreFallbacks: true });
    const row = result.standardFields.find((r) => r.canonicalKey === 'property_address');
    expect(row.value).toBe('12350 South Northshore, Knoxville, TN 37922');
    expect(row.status).toBe('needs_review');
    expect(row.sourcePage).toBe(1);
    expect(row.sourceProvider).toBe('no_provider_payload_fallback');
    expect(row.validationMessage).toMatch(/tenant\/contact address/i);
  });

  it('does not fill missing property_address from premises text unless no-provider core fallback is opted in', () => {
    const result = normalizeLeaseReviewData(camHeavyLease({ fields: { property_address: null }, field_evidence: { property_address: null } }));
    const row = result.standardFields.find((r) => r.canonicalKey === 'property_address');
    expect(row.value).toBeNull();
    expect(row.sourceProvider).not.toBe('no_provider_payload_fallback');

    const diagnosticResult = normalizeLeaseReviewData(
      camHeavyLease({ fields: { property_address: null }, field_evidence: { property_address: null } }),
      { allowNoProviderCoreFallbacks: true },
    );
    const diagnosticRow = diagnosticResult.standardFields.find((r) => r.canonicalKey === 'property_address');
    expect(diagnosticRow.value).toBe('12350 South Northshore, Knoxville, TN 37922');
    expect(diagnosticRow.sourceText).toMatch(/Demised Premises|Premises/i);
  });

  it('prefers premises/demised-premises source text when property_address is missing in diagnostic fallback mode', () => {
    const result = normalizeLeaseReviewData(
      camHeavyLease({ fields: { property_address: null }, field_evidence: { property_address: null } }),
      { allowNoProviderCoreFallbacks: true },
    );
    const row = result.standardFields.find((r) => r.canonicalKey === 'property_address');
    expect(row.value).toBe('12350 South Northshore, Knoxville, TN 37922');
    expect(row.sourceText).toMatch(/Demised Premises|Premises/i);
  });

  it('creates CAM and expense recovery fallback rules with evidence from stored text', () => {
    const result = normalizeLeaseReviewData(camHeavyLease(), { allowDiagnosticExpenseRuleFallbacks: true });
    expect(result.camRules.some((row) => row.category === 'common_area_maintenance_estimate' && row.value === '$5.25 per leasable square foot' && row.sourcePage === 14)).toBe(true);
    expect(result.camRules.some((row) => row.category === 'common_area_maintenance' && row.responsibleParty === 'tenant')).toBe(true);
    expect(result.camRules.some((row) => row.category === 'administrative_fee' && row.adminFeePercent === 5)).toBe(true);
    expect(result.expenseRules.some((row) => row.category === 'real_estate_taxes' && row.sourcePage === 2)).toBe(true);
    expect(result.expenseRules.some((row) => row.category === 'insurance_premiums' && row.sourcePage === 2)).toBe(true);
  });

  it('creates Rent Addendum schedule rows without flattening the schedule into monthly_rent', () => {
    const result = normalizeLeaseReviewData(camHeavyLease());
    const scheduleRows = result.tabs.rent_charges.filter((row) => row.rowType === 'dynamic' && row.category === 'rent_schedule');
    expect(scheduleRows.map((row) => row.label)).toContain('Rent Addendum Months 3-12');
    expect(scheduleRows[0].status).toBe('needs_review');
    expect(scheduleRows[0].sourcePage).toBe(14);
    const monthlyRent = result.standardFields.find((row) => row.canonicalKey === 'monthly_rent');
    expect(monthlyRent.value).toBeNull();
  });

  it('does not project Security Deposit Addendum total into core fields by default', () => {
    const result = normalizeLeaseReviewData(camHeavyLease());
    const row = result.standardFields.find((r) => r.canonicalKey === 'security_deposit');
    expect(row.value).toBeNull();
    expect(row.sourceProvider).not.toBe('no_provider_payload_fallback');
  });

  it('projects Security Deposit Addendum total in diagnostic fallback mode only', () => {
    const result = normalizeLeaseReviewData(camHeavyLease(), { allowNoProviderCoreFallbacks: true });
    const row = result.standardFields.find((r) => r.canonicalKey === 'security_deposit');
    expect(row.value).toBe(15535.36);
    expect(row.status).toBe('needs_review');
    expect(row.sourcePage).toBe(16);
    expect(row.sourceText).toMatch(/\$12,908\.60/);
    expect(row.sourceText).toMatch(/\$15,535\.36/);
  });

  it('does not duplicate fallback expense/CAM rows when structured rows already exist', () => {
    const result = normalizeLeaseReviewData(camHeavyLease({
      extraction_data: {
        workflow_output: {
          document_profile: { documentType: 'base_lease' },
          expense_rules: [
            { expense_category: 'common_area_maintenance_estimate', normalized_rule: 'Existing CAM estimate', recoverable_flag: true, source_page: 14 },
          ],
        },
      },
    }), { allowDiagnosticExpenseRuleFallbacks: true });
    expect(result.camRules.filter((row) => row.category === 'common_area_maintenance_estimate')).toHaveLength(1);
  });

  it('keeps existing assignment behavior unchanged', () => {
    const result = normalizeLeaseReviewData({
      extraction_data: {
        workflow_output: { document_profile: { documentType: 'assignment' } },
        fields: { assignee_name: 'NARENDRA PYDI', assignment_effective_date: '2023-11-07' },
        field_evidence: {
          assignee_name: { source_text: 'NARENDRA PYDI, Assignee', source_page: 1 },
          assignment_effective_date: { source_text: 'as of November 7, 2023', source_page: 1 },
          assignor_name: { source_text: 'Assignor and Assignee desire to enter into this Agreement', source_page: 1 },
        },
      },
    });
    expect(result.currentReviewPolicy.profile).toBe('assignment');
    expect(result.approvalBlockers.missingFields).toEqual(['assignor_name']);
    expect(result.approvalBlockers.budgetBlockers).toEqual([]);
    expect(result.approvalBlockers.camBlockers).toEqual([]);
  });

  it('keeps Craven-style fallback rows intact when Clause Records are filtered', () => {
    const result = normalizeLeaseReviewData(camHeavyLease(), { allowDiagnosticExpenseRuleFallbacks: true });
    expect(result.clauseRecords).toEqual([]);
    expect(result.expenseRules.some((row) => row.category === 'real_estate_taxes')).toBe(true);
    expect(result.expenseRules.some((row) => row.category === 'insurance_premiums')).toBe(true);
    expect(result.camRules.some((row) => row.category === 'common_area_maintenance_estimate' && row.value === '$5.25 per leasable square foot')).toBe(true);
    expect(result.camRules.some((row) => row.category === 'common_area_maintenance')).toBe(true);
    expect(result.camRules.some((row) => row.category === 'administrative_fee' && row.adminFeePercent === 5)).toBe(true);
    expect(result.tabs.rent_charges.filter((row) => row.category === 'rent_schedule')).toHaveLength(3);
    const securityDeposit = result.standardFields.find((row) => row.canonicalKey === 'security_deposit');
    expect(securityDeposit.value).toBeNull();
  });

  it('keeps Phase 46 base-lease alias behavior unchanged', () => {
    const result = normalizeLeaseReviewData({
      document_subtype: 'base_lease',
      extraction_data: {
        workflow_output: { document_profile: { documentType: 'base_lease' } },
        fields: {
          property_address: '224 S Peters Road Knoxville, TN 37923',
          monthly_rent: 1400,
          security_deposit: 1400,
        },
        field_evidence: {
          property_address: { source_text: 'located at 224 S Peters Road Knoxville, TN 37923', source_page: 1 },
          monthly_rent: { source_text: '$1,400 per month', source_page: 1 },
          security_deposit: { source_text: 'Security Deposit $1,400', source_page: 1 },
        },
      },
    });
    expect(result.approvalBlockers.missingFields).not.toContain('premises_address');
  });
});

describe("amendment placeholder recovery", () => {
  function rowFor(fieldKey, value, sourceText) {
    const lease = {
      id: `placeholder-${fieldKey}`,
      extraction_data: {
        fields: {
          [fieldKey]: {
            value,
            normalized_value: value,
            source_page: 1,
            source_text: sourceText,
            confidence: 0.99,
            extraction_status: "extracted",
          },
        },
        field_evidence: {
          [fieldKey]: {
            value,
            normalized_value: value,
            source_page: 1,
            source_text: sourceText,
            confidence: 0.99,
            extraction_status: "extracted",
          },
        },
      },
    };

    return normalizeStandardFields(lease).find((row) => row.canonicalKey === fieldKey);
  }

  it("recovers premises address when the extracted value only repeats the field label", () => {
    const row = rowFor(
      "property_address",
      "Premises Address",
      'for the lease of approximately 4,200 rentable square feet of space (the "Premises") located at 7804 Montvue Center Way, Knoxville, Tennessee,'
    );

    expect(row.value).toBe("7804 Montvue Center Way, Knoxville, Tennessee");
    expect(row.status).toBe("auto_populated");
    expect(row.extractionMode).toBe(EXTRACTION_MODES.EXPLICIT);
    expect(row.sourceProvider).toBe("source_text_placeholder_recovery");
  });

  it("recovers assignee notice address from cited notice text", () => {
    const row = rowFor(
      "assignee_notice_address",
      "Assignee Notice Address",
      "The notice address for Assignee for all purposes under the Lease shall be: 1240 BENTLEY PARK LN, KNOXVILLE, TN-37922"
    );

    expect(row.value).toBe("1240 BENTLEY PARK LN, KNOXVILLE, TN-37922");
    expect(row.status).toBe("auto_populated");
  });

  it("recovers amendment expiration/end date from cited source text", () => {
    const row = rowFor(
      "end_date",
      "End Date",
      "Landlord agrees to extend the initial Term of the Lease by one year and said initial Term shall now expire September 30, 2029."
    );

    expect(row.value).toBe("2029-09-30");
    expect(row.status).toBe("auto_populated");
  });

  it("recovers square footage from cited premises text", () => {
    const row = rowFor(
      "square_footage",
      "Square Footage",
      'for the lease of approximately 4,200 rentable square feet of space (the "Premises") located at 7804 Montvue Center Way, Knoxville, Tennessee,'
    );

    expect(row.value).toBe(4200);
    expect(row.status).toBe("auto_populated");
  });

  it("rejects unrecoverable label-only placeholder values", () => {
    const row = rowFor("notes", "Notes", "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE");

    expect(row.value).toBeNull();
    expect(row.invalidValueRejected).toBe(true);
    expect(row.validationMessage).toMatch(/matched the field label/i);
  });

  it("does not display label-only dynamic findings as extracted values", () => {
    const rows = normalizeDynamicFindings({
      extraction_data: {
        workflow_output: {
          extracted_document_items: [{
            item_type: "custom_operating_condition",
            label: "Custom Operating Condition",
            value: "Custom Operating Condition",
            source_text: "Tenant fails to perform any other covenant, condition or agreement contained in this Lease not covered by the preceding subsections, where such failure continues for thirty (30) days after notice thereof from Landlord to Tenant",
            source_page: 10,
            confidence: 0.98,
          }],
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].status).toBe("needs_review");
    expect(rows[0].reviewReason).toMatch(/repeated the row label/i);
  });

  it("uses clause source text instead of clause title as the displayed clause value", () => {
    const result = normalizeLeaseReviewData({
      extraction_data: {
        workflow_output: {
          lease_clauses: [{
            clause_type: "landlord_consent_for_transfer",
            title: "Landlord Consent For Transfer",
            source_text: "Tenant shall not make any Transfer without the prior consent of Landlord, which Landlord shall not unreasonably withhold or delay.",
            source_page: 7,
            confidence: 0.99,
          }],
        },
      },
    });

    const row = result.tabs.clause_records.find((item) => item.fieldKey === "landlord_consent_for_transfer");
    expect(row.value).toMatch(/Tenant shall not make any Transfer/);
    expect(row.value).not.toBe("Landlord Consent For Transfer");
  });
});
describe("Phase 5F reviewer projection authority", () => {
  function phase5fSecurityDepositLease() {
    return {
      id: "phase5f-security-deposit-projection",
      security_deposit: 32500,
      extraction_data: {
        fields: {
          security_deposit: {
            value: 30000,
            normalized_value: 30000,
            source_page: 6,
            source_text: "Security deposit listed as $30,000 in one paragraph.",
            confidence: 0.53,
            extraction_status: "conflict_detected",
          },
        },
        field_evidence: {
          security_deposit: {
            value: 30000,
            normalized_value: 30000,
            source_page: 6,
            source_text: "Security deposit listed as $30,000 in one paragraph.",
            confidence: 0.53,
            extraction_status: "conflict_detected",
          },
        },
        field_reviews: {
          security_deposit: {
            status: REVIEW_STATUSES.EDITED,
            value: 32500,
            source_page: 6,
            source_text: "Reviewer confirmed the signed security deposit is $32,500.",
            reviewed_at: "2026-07-17T09:30:00.000Z",
          },
        },
      },
    };
  }

  it("uses reviewer-resolved Security Deposit before extracted fallback without duplicating the row", () => {
    const lease = phase5fSecurityDepositLease();
    expect(lease.extraction_data.fields.security_deposit.normalized_value).toBe(30000);
    expect(lease.security_deposit).toBe(32500);
    expect(lease.extraction_data.field_reviews.security_deposit.value).toBe(32500);

    const result = normalizeLeaseReviewData(lease);
    const securityDepositRows = result.standardFields.filter((row) => row.canonicalKey === "security_deposit");
    expect(securityDepositRows).toHaveLength(1);

    const row = securityDepositRows[0];
    expect(row.value).toBe(32500);
    expect(row.normalized_value).toBe(32500);
    expect(row.display_value).toBe(32500);
    expect(row.status).toBe("manually_edited");
    expect(row.extractionMode).toBe(EXTRACTION_MODES.REVIEWER_ENTERED);
    expect(row.source_page).toBe(6);
    expect(row.source_text).toMatch(/32,500/);

    const rentRows = result.tabs.rent_charges.filter((row) => row.canonicalKey === "security_deposit");
    expect(rentRows).toHaveLength(1);
    expect(rentRows[0].value).toBe(32500);
    expect(result.dynamicFindings.some((row) => row.fieldKey === "security_deposit" || row.canonicalKey === "security_deposit")).toBe(false);
  });

  it("uses the reviewed typed lease column before the extracted fallback when no field review is present", () => {
    const lease = phase5fSecurityDepositLease();
    delete lease.extraction_data.field_reviews.security_deposit;

    const result = normalizeLeaseReviewData(lease);
    const row = result.standardFields.find((item) => item.canonicalKey === "security_deposit");

    expect(lease.extraction_data.fields.security_deposit.normalized_value).toBe(30000);
    expect(lease.security_deposit).toBe(32500);
    expect(row.value).toBe(32500);
    expect(row.normalized_value).toBe(32500);
  });
});
