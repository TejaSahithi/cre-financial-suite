import { describe, it, expect } from 'vitest';
import {
  toNullableNumber,
  toBooleanString,
  fromBooleanString,
  normalizeRuleToken,
  normalizeDisplayKey,
  isSupersededRule,
  displayDedupeKey
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
    expect(displayDedupeKey(row)).toBe("123::taxes::real_estate");
  });
});
