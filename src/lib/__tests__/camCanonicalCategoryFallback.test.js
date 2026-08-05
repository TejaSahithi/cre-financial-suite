/**
 * Guards the pre-/post-migration-039 boundary in the CAM Setup UI.
 *
 * Migration 039 adds cam_expense_inputs.expense_category_id. Until it is
 * deployed to a given environment the field is absent from the payload
 * entirely. A naive `!row.expense_category_id` check would then be true for
 * EVERY published expense and flood CAM Setup with false
 * EXPENSE_CATEGORY_MISSING blockers — which is why the UI must not assume the
 * migration is live.
 */
import { describe, it, expect } from "vitest";
import { computeExpenseGapExceptions, hasCanonicalCategoryColumn } from "@/lib/camReadiness";
import { suggestPools } from "@/lib/camSuggestions";

const CATEGORY_UUID = "3f1b9c62-5d4a-4e37-9a21-0c8e5b7d1a44";

// Pre-039 shape: no expense_category_id property at all.
const preMigrationRow = {
  id: "exp-1",
  category: "Insurance",
  amount: 100000,
  service_period_start: "2026-01-01",
  service_period_end: "2026-12-31",
};

// Post-039 shape: property present, value resolved.
const resolvedRow = { ...preMigrationRow, id: "exp-2", expense_category_id: CATEGORY_UUID };

// Post-039 shape: property present but deliberately unresolved (ambiguous label).
const unresolvedRow = { ...preMigrationRow, id: "exp-3", expense_category_id: null };

describe("hasCanonicalCategoryColumn", () => {
  it("is false when no row carries the column (pre-migration environment)", () => {
    expect(hasCanonicalCategoryColumn([preMigrationRow])).toBe(false);
  });

  it("is true when the column is present even though its value is null", () => {
    expect(hasCanonicalCategoryColumn([unresolvedRow])).toBe(true);
  });

  it("is false for an empty or missing list", () => {
    expect(hasCanonicalCategoryColumn([])).toBe(false);
    expect(hasCanonicalCategoryColumn(undefined)).toBe(false);
  });
});

describe("computeExpenseGapExceptions", () => {
  it("does NOT raise EXPENSE_CATEGORY_MISSING pre-migration when a label exists", () => {
    const items = computeExpenseGapExceptions([preMigrationRow]);
    expect(items.filter((i) => i.code === "EXPENSE_CATEGORY_MISSING")).toHaveLength(0);
  });

  it("raises EXPENSE_CATEGORY_MISSING post-migration when the canonical id is null", () => {
    const items = computeExpenseGapExceptions([unresolvedRow]);
    const missing = items.filter((i) => i.code === "EXPENSE_CATEGORY_MISSING");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("blocking");
    expect(missing[0].entityId).toBe("exp-3");
  });

  it("does not raise it when the canonical id is resolved", () => {
    const items = computeExpenseGapExceptions([resolvedRow]);
    expect(items.filter((i) => i.code === "EXPENSE_CATEGORY_MISSING")).toHaveLength(0);
  });

  it("ignores a zero-amount row: a blocker must be financially material", () => {
    const items = computeExpenseGapExceptions([{ ...unresolvedRow, amount: 0 }]);
    expect(items.filter((i) => i.code === "EXPENSE_CATEGORY_MISSING")).toHaveLength(0);
  });

  it("still flags a genuinely uncategorised row pre-migration (no label at all)", () => {
    const items = computeExpenseGapExceptions([{ ...preMigrationRow, category: null }]);
    expect(items.filter((i) => i.code === "EXPENSE_CATEGORY_MISSING")).toHaveLength(1);
  });
});

describe("suggestPools", () => {
  const policySteps = [
    { lease_id: "lease-1", step_type: "CALCULATE_SHARE", expense_category_id: CATEGORY_UUID },
  ];
  const names = new Map([[CATEGORY_UUID, "Insurance"]]);

  it("never keys a suggestion by the free-text label", () => {
    const suggestions = suggestPools(policySteps, [preMigrationRow], names, new Set());
    // Only the policy-derived category may appear — never "Insurance" the label.
    expect(suggestions.map((s) => s.expense_category_id)).toEqual([CATEGORY_UUID]);
    expect(suggestions[0].canonical_category_available).toBe(false);
    // Pre-migration the expense cannot be counted against a canonical category.
    expect(suggestions[0].expense_count).toBe(0);
  });

  it("counts the expense once the canonical id is present", () => {
    const suggestions = suggestPools(policySteps, [resolvedRow], names, new Set());
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].expense_category_id).toBe(CATEGORY_UUID);
    expect(suggestions[0].expense_count).toBe(1);
    expect(suggestions[0].expense_total).toBe(100000);
    expect(suggestions[0].source).toBe("policy_and_expense");
    expect(suggestions[0].canonical_category_available).toBe(true);
  });

  it("reports provenance naming the exact category UUID that produced it", () => {
    const suggestions = suggestPools(policySteps, [resolvedRow], names, new Set());
    expect(suggestions[0].match_explanation).toContain(CATEGORY_UUID);
  });
});
