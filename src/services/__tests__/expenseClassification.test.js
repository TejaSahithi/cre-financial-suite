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
});
