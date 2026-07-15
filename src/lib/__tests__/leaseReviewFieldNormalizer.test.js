import { describe, it, expect } from "vitest";
import {
  normalizeLeaseReviewData,
  normalizeStandardFields,
  normalizeExpenseRuleRows,
  normalizeExpenseRuleFallback,
  isSignatureDateSourcedFromLeaseReference,
  resolveLeaseReviewExtractionMode,
  normalizeClauseRecords,
} from "@/lib/leaseReviewFieldNormalizer";
import { isMarkupArtifactValue, EXTRACTION_MODES, REVIEW_STATUSES } from "@/lib/leaseReviewSchema";

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

describe("enterprise lease abstract row model", () => {
  it("places monthly_rent only in Rent & Charges as editable and Budget Preview as read-only", () => {
    const result = normalizeLeaseReviewData({ extraction_data: { fields: { monthly_rent: 27865 } } });
    expect(result.tabs.rent_charges.some((row) => row.canonicalKey === "monthly_rent" && row.rowType === "standard" && row.editable)).toBe(true);
    expect(result.tabs.budget_preview.some((row) => row.canonicalKey === "monthly_rent" && row.rowType === "read_only_reference" && row.editable === false)).toBe(true);
    const editableAppearances = Object.values(result.tabs).flat().filter((row) => row.canonicalKey === "monthly_rent" && row.editable).length;
    expect(editableAppearances).toBe(1);
  });

  it("splits expense and CAM rule rows into their related tabs", () => {
    const result = normalizeLeaseReviewData({
      extraction_data: {
        workflow_output: {
          expense_rules: [
            { expense_category: "real_estate_taxes", requires_review: true, source_text: "Tenant shall pay taxes." },
            { expense_category: "common_area_maintenance", requires_review: true, source_text: "Tenant shall pay CAM subject to cap." },
          ],
        },
      },
    });
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
    expect(row.status).toBe("missing");
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
    expect(row.value).toBe("NARENDRA PYDI");
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
