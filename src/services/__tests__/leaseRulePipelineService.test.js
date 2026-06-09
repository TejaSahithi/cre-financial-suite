import { describe, it, expect } from 'vitest';
import { applyLeaseEvidenceRules, isPersistableExpenseRule } from '../leaseRulePipelineService';
import { MOCK_APPROVED_CAM_RULE } from './fixtures/camFixtures';

describe('leaseRulePipelineService - Evidence Rules', () => {
  it('tenant-direct language produces the current tenant-direct/non-CAM outcome', () => {
    const sourceText = "Tenant shall maintain the HVAC system.";
    const rule = { ...MOCK_APPROVED_CAM_RULE, exact_source_text: sourceText, category_name: "HVAC", expense_category: "hvac" };
    
    const result = applyLeaseEvidenceRules(rule, sourceText);
    expect(result.payment_treatment).toBe("tenant_direct_contract");
  });

  it('explicit exclusion language produces current excluded/non-CAM outcome', () => {
    const sourceText = "This expense shall be excluded from Operating Expenses.";
    const rule = { ...MOCK_APPROVED_CAM_RULE, exact_source_text: sourceText, category_name: "Management Fee", expense_category: "management_fees" };
    
    const result = applyLeaseEvidenceRules(rule, sourceText);
    expect(result.row_status).toBe("not_applicable");
    expect(result.is_excluded).toBe(true);
  });

  it('does not persist weak expense rows without category-supporting source evidence', () => {
    const sourceText = "Tenant shall use the Premises only for restaurant operations.";
    const rule = { ...MOCK_APPROVED_CAM_RULE, exact_source_text: sourceText, category_name: "CAM", expense_category: "common_area_maintenance" };

    const result = applyLeaseEvidenceRules(rule, sourceText);
    expect(result.extraction_status).toBe("weak_evidence");
    expect(isPersistableExpenseRule(result)).toBe(false);
  });

  it('persists a clause-backed CAM rule with category-specific evidence', () => {
    const sourceText = "Tenant shall pay its pro rata share of Common Area Maintenance expenses as Additional Rent.";
    const rule = { ...MOCK_APPROVED_CAM_RULE, exact_source_text: sourceText, category_name: "CAM", expense_category: "common_area_maintenance" };

    const result = applyLeaseEvidenceRules(rule, sourceText);
    expect(result.extraction_status).toBe("extracted");
    expect(isPersistableExpenseRule(result)).toBe(true);
  });
});
