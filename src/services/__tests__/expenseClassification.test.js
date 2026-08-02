import { describe, it, expect } from 'vitest';
import { buildAmountBuckets, canSendClassificationToCam, scoreRuleMatch } from '../expenseService';
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
});
