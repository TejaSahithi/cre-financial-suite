import { describe, it, expect } from 'vitest';
import { buildAmountBuckets, canSendClassificationToCam, expenseService, scoreRuleMatch } from '../expenseService';
import { MOCK_ACTUAL_EXPENSE, MOCK_APPROVED_CAM_RULE, MOCK_CLASSIFICATION_RECORD } from './fixtures/camFixtures';

describe('expenseService - CAM Classification Helpers', () => {
  it('buildAmountBuckets places 1000 in recoverable_amount and 0 elsewhere', () => {
    const result = buildAmountBuckets(1000, "recoverable");
    expect(result.recoverable_amount).toBe(1000);
    expect(result.non_recoverable_amount).toBe(0);
    expect(result.conditional_amount).toBe(0);
    expect(result.excluded_amount).toBe(0);
  });

  it('buildAmountBuckets handles non-recoverable case correctly', () => {
    const result = buildAmountBuckets(500, "non_recoverable");
    expect(result.recoverable_amount).toBe(0);
    expect(result.non_recoverable_amount).toBe(500);
    expect(result.conditional_amount).toBe(0);
    expect(result.excluded_amount).toBe(0);
  });

  it('canSendClassificationToCam returns true for finalized classification tied to an approved/published CAM rule', () => {
    const classification = {
      ...MOCK_CLASSIFICATION_RECORD,
      classification_status: "finalized",
      cam_eligible: "yes",
      recoverability_result: "recoverable"
    };
    const rule = { ...MOCK_APPROVED_CAM_RULE, published_to_cam: true };
    const expense = { ...MOCK_ACTUAL_EXPENSE, amount: 1000 };

    expect(canSendClassificationToCam({ classification, expense, rule })).toBe(true);
  });

  it('canSendClassificationToCam allows finalized CAM-eligible actuals with a manual reason when the rule is not pre-published', () => {
    const classification = {
      ...MOCK_CLASSIFICATION_RECORD,
      classification_status: "finalized",
      cam_eligible: "yes",
      recoverability_result: "recoverable",
      sent_to_cam: false,
    };
    const rule = { ...MOCK_APPROVED_CAM_RULE, recoverable_from_tenant: "yes", cam_eligible: "yes", published_to_cam: false };
    const expense = { ...MOCK_ACTUAL_EXPENSE, amount: 1000 };

    expect(canSendClassificationToCam({ classification, expense, rule })).toBe(false);
    expect(canSendClassificationToCam({ classification, expense, rule, manualReason: "Reviewer approved CAM send" })).toBe(true);
  });
  it('canSendClassificationToCam returns false for needs-review or missing-rule case', () => {
    const classification = {
      ...MOCK_CLASSIFICATION_RECORD,
      classification_status: "needs_review",
    };
    const expense = { ...MOCK_ACTUAL_EXPENSE, amount: 1000 };

    expect(canSendClassificationToCam({ classification, expense, rule: null })).toBe(false);
  });


  it('scoreRuleMatch uses lease rule expense_category when category_name is absent', () => {
    const expense = { ...MOCK_ACTUAL_EXPENSE, category: "insurance", description: "Property insurance premium" };
    const rule = { ...MOCK_APPROVED_CAM_RULE, category_name: null, expense_category: "insurance", expense_subcategory: null };

    expect(scoreRuleMatch(expense, rule)).toBeGreaterThan(0);
  });
  it('scoreRuleMatch scores direct recovery_rule_id match higher than a category-only match', () => {
    const directMatchExpense = { ...MOCK_ACTUAL_EXPENSE, recovery_rule_id: MOCK_APPROVED_CAM_RULE.id };
    const categoryOnlyExpense = { ...MOCK_ACTUAL_EXPENSE, recovery_rule_id: null };

    const directScore = scoreRuleMatch(directMatchExpense, MOCK_APPROVED_CAM_RULE);
    const categoryScore = scoreRuleMatch(categoryOnlyExpense, MOCK_APPROVED_CAM_RULE);
    const unrelatedRule = { ...MOCK_APPROVED_CAM_RULE, category_name: "Unrelated Category", expense_category: "unrelated" };
    const unrelatedScore = scoreRuleMatch(categoryOnlyExpense, unrelatedRule);

    expect(directScore).toBeGreaterThan(categoryScore);
    expect(categoryScore).toBeGreaterThan(unrelatedScore);
  });

  describe('isApprovedExpenseRecord', () => {
    // Regression: a prior classification run stamping exception_type
    // ("unmatched"/"low_confidence"/"missing_decision"/"manual_review" --
    // see runExpenseClassification's own writes) used to permanently
    // exclude the expense from ever being reconsidered by Expense
    // Classification, because the gate treated any exception_type other
    // than "none"/"resolved" as disqualifying -- but nothing in the
    // codebase ever writes "resolved", so a genuinely approved expense
    // that just couldn't be matched to a rule became invisible forever.
    it('stays eligible when approved but the classification engine flagged it unmatched/low-confidence/manual-review', () => {
      const approvedExpense = { ...MOCK_ACTUAL_EXPENSE, approval_status: "approved", approved_status: "approved", review_status: "approved" };

      for (const exceptionType of ["unmatched", "low_confidence", "missing_decision", "manual_review"]) {
        const classification = { ...MOCK_CLASSIFICATION_RECORD, classification_status: "unmatched", exception_type: exceptionType };
        expect(expenseService.isApprovedExpenseRecord(approvedExpense, classification)).toBe(true);
      }
    });

    it('still excludes an expense that is genuinely rejected, draft, or needs_review', () => {
      expect(expenseService.isApprovedExpenseRecord({ ...MOCK_ACTUAL_EXPENSE, approval_status: "rejected" })).toBe(false);
      expect(expenseService.isApprovedExpenseRecord({ ...MOCK_ACTUAL_EXPENSE, approval_status: "draft" })).toBe(false);
      expect(expenseService.isApprovedExpenseRecord({ ...MOCK_ACTUAL_EXPENSE, approval_status: "needs_review" })).toBe(false);
    });
  });

  describe('matchActualExpenseToLeaseRule (CAM audit regression -- scope must never establish a match by itself)', () => {
    // Root cause found in the end-to-end audit: scoreScopeMatch alone awards
    // 120-880 points for same lease/unit/building/property, which already
    // clears the >=120 acceptance bar with zero category relevance. Real
    // fixture: 5 of 7 approved Macon Crossing expenses (real estate taxes,
    // property insurance, parking-lot resurfacing, roof repair, a legal fee)
    // all landed on the SAME unrelated "utilities" rule, because it was the
    // first-created rule on that lease and nothing required any of them to
    // actually be about utilities.
    const approvedExpense = (overrides = {}) => ({
      ...MOCK_ACTUAL_EXPENSE,
      approval_status: "approved",
      approved_status: "approved",
      review_status: "approved",
      amount: 1000,
      ...overrides,
    });
    const approvedRule = (overrides = {}) => ({ ...MOCK_APPROVED_CAM_RULE, ...overrides });
    const leaseOne = { id: "lease-1", property_id: "prop-1" };

    it('same lease + wrong category does NOT match', () => {
      const expense = approvedExpense({
        id: "exp-tax", lease_id: "lease-1",
        category: "real_estate_taxes", expense_subcategory: "premises_property_tax", description: "Real estate taxes",
      });
      const utilitiesRule = approvedRule({
        id: "rule-utilities", lease_id: "lease-1",
        category_name: "Utilities", expense_category: "utilities", expense_subcategory: "water_gas_heat",
      });
      const rulesByLeaseId = new Map([["lease-1", [utilitiesRule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBeNull();
      expect(result.rule).toBeNull();
      expect(result.recoverability_result).toBe("needs_review");
    });

    it('same lease + correct category DOES match', () => {
      const expense = approvedExpense({ id: "exp-cam", lease_id: "lease-1", category: "common_area_maintenance" });
      const camRule = approvedRule({ id: "rule-cam", lease_id: "lease-1" }); // MOCK_APPROVED_CAM_RULE is already common_area_maintenance
      const rulesByLeaseId = new Map([["lease-1", [camRule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBe("rule-cam");
      expect(result.rule?.id).toBe("rule-cam");
    });

    it('no category-relevant rule returns unmatched / needs review', () => {
      const expense = approvedExpense({
        id: "exp-legal", lease_id: "lease-1",
        category: "assignment_review_fee", expense_subcategory: "legal_review", description: "Landlord legal review fee",
      });
      const rulesByLeaseId = new Map([["lease-1", []]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBeNull();
      expect(result.matchCandidateCount).toBe(0);
      expect(result.recoverability_result).toBe("needs_review");
      expect(result.cam_eligible).toBe("needs_review");
    });

    it('two category-relevant rules on the same lease surface as a conflict candidate count, not an arbitrary winner', () => {
      const expense = approvedExpense({ id: "exp-cam2", lease_id: "lease-1", category: "common_area_maintenance" });
      const ruleA = approvedRule({ id: "rule-cam-a", lease_id: "lease-1", recovery_treatment: "pooled_recovery" });
      const ruleB = approvedRule({ id: "rule-cam-b", lease_id: "lease-1", recovery_treatment: "direct_recovery" });
      const rulesByLeaseId = new Map([["lease-1", [ruleA, ruleB]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      // Both rules are genuinely category-relevant and score identically.
      // matchCandidateCount > 1 is the exact signal isPolicyConflict() in
      // expenseClassificationUiContract.js already reads to route a row to
      // "Multiple Policy Matches" / conditional review instead of silently
      // trusting whichever rule happened to win the tie -- this proves that
      // signal still fires under the new category-fit gate.
      expect(result.matchCandidateCount).toBeGreaterThan(1);
      expect(result.linked_expense_rule_id).not.toBeNull();
    });

    it('a pooled/property-wide expense is not forced onto an irrelevant rule merely because it carries a lease_id', () => {
      // Same shape as the real audit bug: a property-wide invoice (shared
      // parking-lot resurfacing) was assigned a lease_id for scope purposes,
      // but that lease's only approved rule is unrelated (tenant-direct
      // utilities). Having a lease_id must not, by itself, force a match.
      const expense = approvedExpense({
        id: "exp-parking", lease_id: "lease-1",
        category: "parking_lot_maintenance", expense_subcategory: "resurfacing", description: "Parking area resurfacing",
      });
      const utilitiesRule = approvedRule({ id: "rule-utilities-2", lease_id: "lease-1", category_name: "Utilities", expense_category: "utilities" });
      const rulesByLeaseId = new Map([["lease-1", [utilitiesRule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBeNull();
    });
  });

  describe('hasCategoryRelevantMatch (canonical category precedence hardening)', () => {
    // Precedence under audit: explicit recovery_rule_id -> exact canonical
    // expense_category_id match (authoritative when populated on both sides)
    // -> normalized category relationship (org row vs system-default row
    // sharing normalized_key) -> free-text/token fallback -> unmatched.
    const leaseOne = { id: "lease-1", property_id: "prop-1" };
    const approvedExpense = (overrides = {}) => ({
      ...MOCK_ACTUAL_EXPENSE,
      approval_status: "approved",
      approved_status: "approved",
      review_status: "approved",
      lease_id: "lease-1",
      amount: 1000,
      ...overrides,
    });
    const approvedRule = (overrides = {}) => ({ ...MOCK_APPROVED_CAM_RULE, lease_id: "lease-1", ...overrides });

    it('exact category UUID match succeeds even when labels differ', () => {
      const expense = approvedExpense({
        id: "exp-uuid-1",
        expense_category_id: "cat-uuid-shared",
        category: "Random label that looks unrelated",
        expense_subcategory: "Nothing like the rule wording",
      });
      const rule = approvedRule({
        id: "rule-uuid-1",
        expense_category_id: "cat-uuid-shared",
        category_name: "Completely different wording",
        expense_category: "totally_different_label",
      });
      const rulesByLeaseId = new Map([["lease-1", [rule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBe("rule-uuid-1");
    });

    it('different category UUIDs do not match merely because scope is identical', () => {
      const expense = approvedExpense({
        id: "exp-uuid-2",
        expense_category_id: "cat-uuid-a",
        category: "common_area_maintenance",
      });
      const rule = approvedRule({
        id: "rule-uuid-2",
        lease_id: "lease-1", // same lease/property scope as the expense
        expense_category_id: "cat-uuid-b", // different canonical category
        category_name: "Common Area Maintenance",
        expense_category: "common_area_maintenance", // would token-match if ids were ignored
      });
      const rulesByLeaseId = new Map([["lease-1", [rule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBeNull();
      expect(result.recoverability_result).toBe("needs_review");
    });

    it('text fallback works only when canonical relationship is unavailable', () => {
      const textOnlyExpense = approvedExpense({ id: "exp-text-1", category: "common_area_maintenance" });
      const textOnlyRule = approvedRule({ id: "rule-text-1" });
      const textOnlyLookup = new Map([["lease-1", [textOnlyRule]]]);
      const textOnlyResult = expenseService.matchActualExpenseToLeaseRule(textOnlyExpense, {
        leases: [leaseOne],
        rulesByLeaseId: textOnlyLookup,
      });
      expect(textOnlyResult.linked_expense_rule_id).toBe("rule-text-1");

      // Same overlapping labels, but now both sides carry canonical ids and
      // they differ -- the canonical mismatch must win over token overlap.
      const canonicalExpense = approvedExpense({
        id: "exp-text-2",
        expense_category_id: "cat-uuid-a",
        category: "common_area_maintenance",
      });
      const canonicalRule = approvedRule({
        id: "rule-text-2",
        expense_category_id: "cat-uuid-b",
        category_name: "Common Area Maintenance",
        expense_category: "common_area_maintenance",
      });
      const canonicalLookup = new Map([["lease-1", [canonicalRule]]]);
      const canonicalResult = expenseService.matchActualExpenseToLeaseRule(canonicalExpense, {
        leases: [leaseOne],
        rulesByLeaseId: canonicalLookup,
      });
      expect(canonicalResult.linked_expense_rule_id).toBeNull();
    });

    it('explicit recovery_rule_id link still works ahead of any category signal', () => {
      const expense = approvedExpense({
        id: "exp-link-1",
        recovery_rule_id: "rule-link-1",
        expense_category_id: "cat-uuid-a",
        category: "completely_unrelated_label",
      });
      const rule = approvedRule({
        id: "rule-link-1",
        expense_category_id: "cat-uuid-b",
        category_name: "Unrelated to the expense label",
        expense_category: "unrelated",
      });
      const rulesByLeaseId = new Map([["lease-1", [rule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      expect(result.linked_expense_rule_id).toBe("rule-link-1");
    });

    it('ambiguous relevant rules still fail closed to review instead of auto-picking', () => {
      const expense = approvedExpense({ id: "exp-ambig-1", expense_category_id: "cat-uuid-shared" });
      const ruleA = approvedRule({ id: "rule-ambig-a", expense_category_id: "cat-uuid-shared" });
      const ruleB = approvedRule({ id: "rule-ambig-b", expense_category_id: "cat-uuid-shared" });
      const rulesByLeaseId = new Map([["lease-1", [ruleA, ruleB]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, { leases: [leaseOne], rulesByLeaseId });

      // Both rules are genuine canonical-id matches. matchCandidateCount > 1
      // is the exact signal isPolicyConflict() reads to route the row to
      // Needs Review / "Multiple Policy Matches" rather than silently
      // trusting whichever rule the loop happened to pick.
      expect(result.matchCandidateCount).toBeGreaterThan(1);
      expect(result.linked_expense_rule_id).not.toBeNull();
    });

    it('normalized category relationship resolves a rule with no stored canonical id via exact category-table text match', () => {
      // Rule never got a backfilled expense_category_id (pre-canonical-model
      // data), but its label exactly matches a real expense_categories row --
      // the same resolve_expense_category_id() lookup, reused client-side.
      const categoriesById = new Map([
        ["cat-system-1", { id: "cat-system-1", category_name: "Common Area Maintenance", normalized_key: "common_area_maintenance", subcategory_name: null }],
      ]);
      const expense = approvedExpense({
        id: "exp-norm-1",
        expense_category_id: "cat-system-1", // already canonical
        category: "Totally different wording", // would NOT token-match the rule below
      });
      const rule = approvedRule({
        id: "rule-norm-1",
        expense_category_id: null, // no stored canonical id
        category_name: "Common Area Maintenance", // exact-matches the category row's category_name
        expense_category: "xyz_fallback_placeholder",
      });
      const rulesByLeaseId = new Map([["lease-1", [rule]]]);

      const result = expenseService.matchActualExpenseToLeaseRule(expense, {
        leases: [leaseOne],
        rulesByLeaseId,
        categoriesById,
      });

      expect(result.linked_expense_rule_id).toBe("rule-norm-1");
    });
  });
});
