import { describe, it, expect } from 'vitest';
import {
  scrubInapplicableStructuredFields,
  VALID_EVIDENCE,
  firstPresent,
  asNumber,
  normalizeKey,
  compactSnippet,
  extractDocumentTextCandidate
} from './leaseRulePipelineText';

describe('leaseRulePipelineText', () => {
  it('scrubInapplicableStructuredFields nullifies irrelevant fields', () => {
    const rule = {
      expense_category: 'Electricity',
      admin_fee_percent: 5,
      admin_fee_applicable: true
    };
    scrubInapplicableStructuredFields(rule);
    expect(rule.admin_fee_percent).toBeNull();
    expect(rule.admin_fee_applicable).toBe(false);
  });

  it('VALID_EVIDENCE filters out invalid strings', () => {
    expect(VALID_EVIDENCE("Short")).toBe(false);
    expect(VALID_EVIDENCE("This is a valid string that is sufficiently long")).toBe(true);
    expect(VALID_EVIDENCE("This string contains manual_review which makes it invalid")).toBe(false);
    expect(VALID_EVIDENCE("Premises: 123 Main St, Suite 100")).toBe(false);
  });

  it('firstPresent returns first truthy/defined value', () => {
    expect(firstPresent(null, undefined, "", "hello")).toBe("hello");
  });

  it('asNumber extracts numeric values', () => {
    expect(asNumber("1,234.56")).toBe(1234.56);
    expect(asNumber("abc")).toBeNull();
  });

  it('normalizeKey formats category keys', () => {
    expect(normalizeKey(" Common Area & Maintenance ")).toBe("common_area_and_maintenance");
  });

  it('compactSnippet truncates correctly', () => {
    expect(compactSnippet("   hello    world  ")).toBe("hello world");
    const longString = "A".repeat(1500);
    expect(compactSnippet(longString, 1200).length).toBe(1203);
  });

  it('prefers the complete Azure compact artifact over capped full_text', () => {
    const result = extractDocumentTextCandidate({
      full_text: 'capped text [truncated]',
      _whole_document_llm_compact: {
        version: 'lease-compact-document-v1',
        nodes: [
          { id: 'page:1', text: 'Complete opening lease text.' },
          { id: 'page:2', text: 'Expense clause from the final page.' },
        ],
        tables: [],
        keyValues: [],
      },
    });

    expect(result).toContain('Complete opening lease text.');
    expect(result).toContain('Expense clause from the final page.');
    expect(result).not.toContain('[truncated]');
  });
});
