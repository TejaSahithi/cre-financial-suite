import { describe, it, expect } from 'vitest';
import {
  isRuleSuperseded,
  isManualOverrideRule,
  isRuleActiveForRuleSetStatus,
} from './leaseExpenseRuleStatus';

describe('leaseExpenseRuleStatus', () => {
  it('isRuleSuperseded returns true if status is superseded', () => {
    expect(isRuleSuperseded({ row_status: 'superseded' })).toBe(true);
    expect(isRuleSuperseded({ status: 'Superseded' })).toBe(true);
    expect(isRuleSuperseded({ extraction_status: 'SUPERSEDED' })).toBe(true);
    expect(isRuleSuperseded({ status: 'active' })).toBe(false);
  });

  it('isManualOverrideRule recognizes manual overrides', () => {
    expect(isManualOverrideRule({ created_from: 'manual' })).toBe(true);
    expect(isManualOverrideRule({ row_status: 'manually_added' })).toBe(true);
    expect(isManualOverrideRule({ source_type: 'llm' })).toBe(false);
  });

  it('isRuleActiveForRuleSetStatus filters correctly', () => {
    expect(isRuleActiveForRuleSetStatus({ row_status: 'archived' })).toBe(false);
    expect(isRuleActiveForRuleSetStatus({ status: 'deleted' })).toBe(false);
    expect(isRuleActiveForRuleSetStatus({ row_status: 'superseded' })).toBe(false);
    expect(isRuleActiveForRuleSetStatus({ status: 'active' })).toBe(true);
  });
});
