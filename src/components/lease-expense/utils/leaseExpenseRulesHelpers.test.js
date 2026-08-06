import { describe, it, expect } from 'vitest';
import {
  toNullableNumber,
  toBooleanString,
  fromBooleanString,
  normalizeRuleToken,
  normalizeDisplayKey,
  isSupersededRule,
  displayDedupeKey,
  dedupeDisplayRows,
  resolveMatchStatus,
  resolveRuleApprovalStatusDisplay,
} from './leaseExpenseRulesHelpers';

describe('leaseExpenseRulesHelpers', () => {
  it('toNullableNumber parses numbers', () => {
    expect(toNullableNumber("123")).toBe(123);
    expect(toNullableNumber("abc")).toBeNull();
    expect(toNullableNumber("")).toBeNull();
  });

  it('toBooleanString converts bools', () => {
    expect(toBooleanString(true)).toBe("yes");
    expect(toBooleanString(false)).toBe("no");
  });

  it('fromBooleanString parses bools', () => {
    expect(fromBooleanString("yes")).toBe(true);
    expect(fromBooleanString("no")).toBe(false);
  });

  it('normalizeRuleToken trims and lowercases', () => {
    expect(normalizeRuleToken("  TEST  ")).toBe("test");
  });

  it('normalizeDisplayKey formats keys', () => {
    expect(normalizeDisplayKey("Test Key & More")).toBe("test_key_more");
  });

  it('isSupersededRule checks statuses', () => {
    expect(isSupersededRule({ status: 'superseded' })).toBe(true);
    expect(isSupersededRule({ row_status: 'SUPERSEDED' })).toBe(true);
    expect(isSupersededRule({ status: 'active' })).toBe(false);
  });

  it('displayDedupeKey generates consistent keys', () => {
    const row = {
      lease: { id: "123" },
      rule: { category_name: "Taxes", subcategory_name: "Real Estate" }
    };
    expect(displayDedupeKey(row)).toBe("123::taxes::real_estate::::::::::::");
  });

  it('does not collapse distinct lease treatments in the same category', () => {
    const rows = [
      {
        lease: { id: "lease-1" },
        rule: {
          category_name: "CAM",
          subcategory_name: "Common Area Maintenance",
          payment_treatment: "included",
          recovery_method: "pro_rata_share",
          allocation_basis: "tenant_share",
          rule_type: "inclusion",
        },
      },
      {
        lease: { id: "lease-1" },
        rule: {
          category_name: "CAM",
          subcategory_name: "Common Area Maintenance",
          payment_treatment: "excluded",
          recovery_method: "direct_bill",
          allocation_basis: "actual_cost",
          rule_type: "exclusion",
        },
      },
    ];

    expect(dedupeDisplayRows(rows)).toHaveLength(2);
  });

  it('preserves every persisted clause row by database identity', () => {
    const rows = [
      { lease: { id: "lease-1" }, rule: { id: "rule-1", category_name: "CAM" } },
      { lease: { id: "lease-1" }, rule: { id: "rule-2", category_name: "CAM" } },
    ];

    expect(dedupeDisplayRows(rows)).toHaveLength(2);
  });

  describe('resolveMatchStatus', () => {
    it('returns null for coverage-gap rows (no actual expense to match)', () => {
      expect(resolveMatchStatus({ rowType: 'rule_missing_actual' })).toBeNull();
    });

    it('flags No Policy Required when there is no rule and cam_eligible is no', () => {
      expect(resolveMatchStatus({ rowType: 'actual_missing_rule', rule: null, camEligible: 'no' }).state)
        .toBe('no_policy_required');
    });

    it('flags Needs Review when there is no rule and cam_eligible is needs_review', () => {
      expect(resolveMatchStatus({ rowType: 'actual_missing_rule', rule: null, camEligible: 'needs_review' }).state)
        .toBe('needs_review');
    });

    it('flags No Policy Coverage when there is no rule and cam_eligible is otherwise resolved', () => {
      expect(resolveMatchStatus({ rowType: 'actual_missing_rule', rule: null, camEligible: 'yes' }).state)
        .toBe('no_policy_coverage');
    });

    it('flags Multiple Policy Matches when more than one candidate qualified', () => {
      const row = {
        rowType: 'matched_classification',
        rule: { payment_treatment: 'reimbursable', recovery_method: 'pro_rata_share' },
        matchCandidateCount: 2,
      };
      expect(resolveMatchStatus(row).state).toBe('multiple_policy_matches');
    });

    it('flags Direct Tenant Policy Found for a direct_bill billing treatment', () => {
      const row = {
        rowType: 'matched_classification',
        rule: { payment_treatment: 'reimbursable', recovery_method: 'direct_bill' },
        matchCandidateCount: 1,
      };
      expect(resolveMatchStatus(row).state).toBe('direct_tenant_policy_found');
    });

    it('flags Policy Coverage Found for a normal single matched rule', () => {
      const row = {
        rowType: 'matched_classification',
        rule: { payment_treatment: 'reimbursable', recovery_method: 'pro_rata_share' },
        matchCandidateCount: 1,
      };
      expect(resolveMatchStatus(row).state).toBe('policy_coverage_found');
    });
  });

  describe('resolveRuleApprovalStatusDisplay', () => {
    it('labels a superseded rule as Superseded, not Approved/Rejected', () => {
      expect(resolveRuleApprovalStatusDisplay({ approval_status: 'superseded' }).label).toBe('Superseded');
    });

    it('labels a structurally not-applicable rule as Not Applicable even if approval_status says approved', () => {
      const rule = {
        approval_status: 'approved',
        is_excluded: true,
        recoverable_from_tenant: 'no',
        cam_eligible: 'no',
      };
      expect(resolveRuleApprovalStatusDisplay(rule).label).toBe('Not Applicable');
    });

    it('labels a rejected rule as Rejected', () => {
      expect(resolveRuleApprovalStatusDisplay({ approval_status: 'rejected' }).label).toBe('Rejected');
    });

    it('labels a genuinely approved rule as Approved', () => {
      expect(resolveRuleApprovalStatusDisplay({ approval_status: 'approved', review_status: 'approved' }).label).toBe('Approved');
    });
  });
});
