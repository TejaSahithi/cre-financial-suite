import { describe, expect, it } from "vitest";
import {
  readReviewedBudgetFieldValue,
  resolveBudgetPreviewInputs,
} from "../utils/budgetPreviewInputs";

function leaseFixture({ fieldReviews = {}, fields = {}, workflow = {}, typed = {} } = {}) {
  return {
    monthly_rent: 9000,
    annual_rent: 108000,
    commencement_date: "2026-01-01",
    start_date: "2026-01-01",
    escalation_rate: 2,
    ...typed,
    extraction_data: {
      fields: {
        monthly_rent: { value: 9000, source_page: 4, source_text: "Sanitized extracted rent clause." },
        commencement_date: { value: "2026-01-01", source_page: 3, source_text: "Sanitized commencement clause." },
        escalation_rate: { value: 2, source_page: 5, source_text: "Sanitized escalation clause." },
        ...fields,
      },
      field_reviews: fieldReviews,
      workflow_output: {
        budget_preview: {
          rent_revenue_budget: [
            { monthly_rent: 10000, start_date: "2026-02-01" },
          ],
        },
        ...workflow,
      },
    },
  };
}

describe("BudgetPreviewCard reviewed input contract", () => {
  it("uses reviewer-edited values before stale workflow preview or typed lease columns", () => {
    const lease = leaseFixture({
      typed: {
        monthly_rent: 99999,
        commencement_date: "2026-01-15",
        escalation_rate: 9,
      },
      fieldReviews: {
        monthly_rent: { status: "edited", value: 13000, note: "Reviewer confirmed schedule." },
        commencement_date: { status: "edited", value: "2026-03-01" },
        escalation_rate: { status: "edited", value: 4 },
      },
    });

    expect(resolveBudgetPreviewInputs(lease)).toEqual({
      monthly: 13000,
      startBasis: "2026-03-01",
      escalationRate: 4,
    });
  });

  it("falls back to extracted values for accepted fields when the review stores status but no override value", () => {
    const lease = leaseFixture({
      fieldReviews: {
        monthly_rent: { status: "accepted", reviewed_at: "2026-07-17T00:00:00.000Z" },
      },
    });

    expect(readReviewedBudgetFieldValue(lease, "monthly_rent")).toBe(9000);
    expect(resolveBudgetPreviewInputs(lease).monthly).toBe(9000);
  });

  it("does not use N/A reviewer values as budget assumptions", () => {
    const lease = leaseFixture({
      fieldReviews: {
        monthly_rent: { status: "not_applicable", value: 1 },
      },
    });

    expect(resolveBudgetPreviewInputs(lease).monthly).toBe(9000);
  });
  it("skips missing numeric candidates instead of coercing them to zero", () => {
    const lease = leaseFixture({
      typed: {
        monthly_rent: null,
        annual_rent: null,
      },
      fields: {
        monthly_rent: { value: null },
      },
      workflow: {
        budget_preview: {
          rent_revenue_budget: [
            { monthly_rent: 11000, start_date: "2026-02-01" },
          ],
        },
      },
    });

    expect(resolveBudgetPreviewInputs(lease).monthly).toBe(11000);
  });
});
