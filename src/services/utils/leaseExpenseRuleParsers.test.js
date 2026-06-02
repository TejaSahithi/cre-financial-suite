import { describe, it, expect } from 'vitest';
import {
  asNumber,
  asArray,
  humanizeLabel,
  normalizeText,
  firstPresent,
  isApprovedWorkflowStatus
} from './leaseExpenseRuleParsers';

describe('leaseExpenseRuleParsers', () => {
  it('asNumber handles various inputs', () => {
    expect(asNumber(null)).toBeNull();
    expect(asNumber(undefined)).toBeNull();
    expect(asNumber("")).toBeNull();
    expect(asNumber(100)).toBe(100);
    expect(asNumber("100")).toBe(100);
    expect(asNumber("$1,000.50")).toBe(1000.50);
    expect(asNumber("abc")).toBeNull();
  });

  it('asArray ensures array output', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray([])).toEqual([]);
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray("test")).toEqual([]);
  });

  it('normalizeText lowercases and trims', () => {
    expect(normalizeText("  HeLLo  ")).toBe("hello");
    expect(normalizeText(null)).toBe("");
  });

  it('humanizeLabel formats keys into words', () => {
    expect(humanizeLabel("common_area_maintenance")).toBe("Common Area Maintenance");
    expect(humanizeLabel("real_estate_taxes")).toBe("Real Estate Taxes");
  });

  it('firstPresent returns first truthy/defined value', () => {
    expect(firstPresent(null, undefined, "hello")).toBe("hello");
    expect(firstPresent("first", "second")).toBe("first");
  });

  it('isApprovedWorkflowStatus recognizes valid statuses', () => {
    expect(isApprovedWorkflowStatus("approved")).toBe(true);
    expect(isApprovedWorkflowStatus("active")).toBe(false);
    expect(isApprovedWorkflowStatus("draft")).toBe(false);
  });
});
