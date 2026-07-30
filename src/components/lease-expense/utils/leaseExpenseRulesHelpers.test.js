import { describe, it, expect } from 'vitest';
import {
  toNullableNumber,
  toBooleanString,
  fromBooleanString,
  normalizeRuleToken,
  normalizeDisplayKey,
  isSupersededRule,
  displayDedupeKey,
  dedupeDisplayRows
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
});
