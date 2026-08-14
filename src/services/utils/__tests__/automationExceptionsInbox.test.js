import { describe, expect, it } from "vitest";
import { buildAutomationExceptionInbox } from "../automationExceptionsInbox";

const openRows = {
  financialControls: [
    { id: "fc-open", property_id: "p1", code: "VARIANCE", category: "repairs", severity: "high", status: "open", assignee: "Alex" },
    { id: "fc-resolved", property_id: "p1", code: "OLD", category: "taxes", severity: "critical", status: "resolved" },
  ],
  occurrences: [
    { id: "occ-overdue", property_id: "p1", lease_id: "lease-1", obligation_id: "obl-1", due_date: "2026-01-01", status: "open" },
    { id: "occ-satisfied", property_id: "p1", lease_id: "lease-1", due_date: "2026-01-01", status: "satisfied" },
  ],
  salesReports: [
    { id: "sales-submitted", property_id: "p1", lease_id: "lease-1", period_start: "2026-01-01", period_end: "2026-01-31", status: "submitted", gross_sales_amount: 1000 },
    { id: "sales-approved", property_id: "p1", lease_id: "lease-1", period_start: "2026-02-01", period_end: "2026-02-28", status: "approved", gross_sales_amount: 1000 },
  ],
  coi: [
    { id: "coi-review", property_id: "p2", lease_id: "lease-2", insurer: "Carrier", expiration_date: "2026-08-01", status: "needs_review" },
    { id: "coi-approved", property_id: "p2", lease_id: "lease-2", insurer: "Carrier", expiration_date: "2027-08-01", status: "approved" },
  ],
  vendorCredentials: [
    { id: "cred-review", vendor_id: "vendor-1", service_type: "electrical", credential_type: "License", expiration_date: "2026-09-01", status: "needs_review" },
    { id: "cred-verified", vendor_id: "vendor-1", service_type: "electrical", credential_type: "License", status: "verified" },
  ],
  referenceSeries: [
    { id: "series-blocked", lease_id: "lease-3", provider: "bls", series_id: "CUUR", display_name: "CPI", status: "blocked" },
    { id: "series-approved", lease_id: "lease-3", provider: "bls", series_id: "CWUR", display_name: "CPI-W", status: "approved" },
  ],
  referenceData: [
    { id: "obs-review", provider: "bls", series_id: "CUUR", period: "2026-M01", value: 300, status: "pending_review" },
    { id: "obs-approved", provider: "bls", series_id: "CUUR", period: "2026-M02", value: 301, status: "approved" },
  ],
  leaseChargeReadModel: [
    { source_record_id: "charge-blocked", authoritative_table: "lease_charge_calculations", property_id: "p1", lease_id: "lease-4", charge_type: "management_fee", period_end: "2026-12-31", status: "blocked", reason_codes: ["REFERENCE_OBSERVATION_REQUIRED"] },
    { source_record_id: "charge-ok", authoritative_table: "lease_charge_calculations", property_id: "p1", lease_id: "lease-4", charge_type: "management_fee", period_end: "2026-12-31", status: "approved", reason_codes: [] },
  ],
  tenantReconciliations: [
    { id: "tr-blocked", property_id: "p1", lease_id: "lease-5", period_start: "2026-01-01", period_end: "2026-12-31", status: "blocked", final_balance: 0, reason_codes: ["BILLED_AMOUNT_MISSING:management_fee"] },
    { id: "tr-posted", property_id: "p1", lease_id: "lease-5", period_start: "2026-01-01", period_end: "2026-12-31", status: "posted", final_balance: 0, reason_codes: [] },
  ],
};

describe("buildAutomationExceptionInbox", () => {
  it("aggregates only open persisted operational records across domains", () => {
    const inbox = buildAutomationExceptionInbox(openRows, { asOfDate: "2026-08-13" });
    const ids = inbox.items.map((item) => item.sourceRecordId);

    expect(ids).toEqual(expect.arrayContaining([
      "fc-open",
      "occ-overdue",
      "sales-submitted",
      "coi-review",
      "cred-review",
      "series-blocked",
      "obs-review",
      "charge-blocked",
      "tr-blocked",
    ]));
    expect(ids).not.toEqual(expect.arrayContaining([
      "fc-resolved",
      "occ-satisfied",
      "sales-approved",
      "coi-approved",
      "cred-verified",
      "series-approved",
      "obs-approved",
      "charge-ok",
      "tr-posted",
    ]));
  });

  it("normalizes source links and summary counts without duplicating authority", () => {
    const inbox = buildAutomationExceptionInbox(openRows, { asOfDate: "2026-08-13" });

    expect(inbox.summary.critical).toBeGreaterThan(0);
    expect(inbox.summary.overdue).toBeGreaterThan(0);
    expect(inbox.summary.needsReview).toBeGreaterThan(0);
    expect(inbox.summary.blocked).toBeGreaterThan(0);
    expect(inbox.items.every((item) => item.sourceTable && item.sourceRecordId && item.actionUrl)).toBe(true);
    expect(inbox.items.find((item) => item.sourceRecordId === "charge-blocked").sourceTable).toBe("lease_charge_calculations");
  });

  it("applies property, domain, severity, status and assignee filters", () => {
    const inbox = buildAutomationExceptionInbox(openRows, {
      asOfDate: "2026-08-13",
      filters: {
        propertyId: "p1",
        domain: "financial-controls",
        severity: "high",
        status: "open",
        assignee: "Alex",
      },
    });

    expect(inbox.filteredItems).toHaveLength(1);
    expect(inbox.filteredItems[0].sourceRecordId).toBe("fc-open");
  });
});

