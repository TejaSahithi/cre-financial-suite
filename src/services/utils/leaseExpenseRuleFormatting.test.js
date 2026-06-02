import { describe, it, expect } from 'vitest';
import {
  deriveRuleConfidence,
  normalizeConfidenceScore,
  extractRuleValue,
  resolveCanonicalExpenseCategory,
  isWeakSourceText
} from './leaseExpenseRuleFormatting';

describe('leaseExpenseRuleFormatting', () => {
  it('deriveRuleConfidence prioritizes fields correctly', () => {
    expect(deriveRuleConfidence({ confidence: 0.85 })).toBe(0.85);
    expect(deriveRuleConfidence({ confidence_score: 0.90 })).toBe(0.90);
    expect(deriveRuleConfidence({})).toBe(0.7);
  });

  it('normalizeConfidenceScore bounds between 0 and 1', () => {
    expect(normalizeConfidenceScore(0.5)).toBe(0.5);
    expect(normalizeConfidenceScore(85)).toBe(0.85);
    expect(normalizeConfidenceScore(-10)).toBe(0);
    expect(normalizeConfidenceScore(150)).toBe(1);
  });

  it('extractRuleValue gets finite numbers', () => {
    expect(extractRuleValue({ final_value: 123.45 })).toBe(123.45);
    expect(extractRuleValue({ extracted_value: "100.5" })).toBe(100.5);
  });

  it('resolveCanonicalExpenseCategory handles standard mappings', () => {
    expect(resolveCanonicalExpenseCategory({ category_name: 'Common Area Maintenance' }).canonicalKey).toBe('common_area_maintenance');
    expect(resolveCanonicalExpenseCategory({ expense_category: 'Electricity' }).canonicalKey).toBe('utilities');
  });

  it('isWeakSourceText identifies generic/short strings', () => {
    expect(isWeakSourceText("included in base rent under lease")).toBe(true);
    expect(isWeakSourceText("short")).toBe(true);
    expect(isWeakSourceText("This is a sufficiently long specific rule extraction string.")).toBe(false);
  });
});
