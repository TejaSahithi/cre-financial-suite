import { describe, it, expect } from 'vitest';
import { leaseExpenseRuleService } from '../leaseExpenseRuleService';
import { MOCK_APPROVED_CAM_RULE, MOCK_TEMPLATE_RULE } from './fixtures/camFixtures';

describe('leaseExpenseRuleService - CAM Publishability', () => {
  it('isRuleCamPublishable returns true for approved rule with valid lease evidence', () => {
    const rule = {
      ...MOCK_APPROVED_CAM_RULE,
      recoverable_from_tenant: "yes",
      cam_eligible: "yes"
    };
    expect(leaseExpenseRuleService.isRuleCamPublishable(rule)).toBe(true);
  });

  it('isRuleCamPublishable returns false for approved/template-like rule missing exact source text', () => {
    const rule = {
      ...MOCK_TEMPLATE_RULE,
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      source_type: "deterministic_template",
      generation_source: "template_checklist"
    };
    expect(leaseExpenseRuleService.isRuleCamPublishable(rule)).toBe(false);
  });
});
