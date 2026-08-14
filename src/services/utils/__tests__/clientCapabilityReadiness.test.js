import { describe, expect, it } from "vitest";
import { buildClientCapabilityReadiness } from "../clientCapabilityReadiness";

describe("clientCapabilityReadiness", () => {
  it("summarizes major client concerns from current platform data", () => {
    const result = buildClientCapabilityReadiness({
      fiscalYear: 2026,
      leases: [{
        id: "lease-1",
        status: "approved",
        abstract_status: "approved",
        abstract_snapshot: {
          approved: {
            monthly_rent: { value: 1000, source_page: 1, source_text: "Rent is $1,000." },
          },
        },
      }],
      rentSchedules: [{ lease_id: "lease-1", status: "approved", row_type: "base_rent" }],
      expenseRules: [{ review_status: "approved", cam_eligible: true, expense_category: "cam" }],
      budgets: [{ status: "approved", budget_year: 2026, expense_items: [{ category: "cam", amount: 1000 }] }],
      camRuns: [{ status: "posted" }],
      expenses: [{ status: "approved", date: "2026-01-01", category: "cam", amount: 900 }],
      criticalDates: [{ date_type: "renewal_notice" }],
      documents: [{ id: "doc-1" }],
      vendors: [{ status: "active" }],
      notifications: [{ id: "notification-1" }],
    });

    expect(result.capabilities.some((item) => item.id === "lease_upload_ai_review")).toBe(true);
    expect(result.capabilities.find((item) => item.id === "effective_dated_rent")?.status).toBe("automated");
    expect(result.summary.averageCoverage).toBeGreaterThan(50);
  });

  it("does not call CPI automated when no exact series exists", () => {
    const result = buildClientCapabilityReadiness({
      expenseRules: [{ cpi_applicable: true }],
    });

    const cpi = result.capabilities.find((item) => item.id === "cpi_reference_data");
    expect(cpi.status).toBe("needs_review");
    expect(cpi.blockers).toBe(1);
  });
});
