import { describe, it, expect } from 'vitest';
import {
  toNumber,
  asNumberOrNull,
  isUuidLike,
  normalizeDateCandidate,
  leaseOverlapsFiscalYear,
  isMissingColumnError
} from './expenseParsers';

describe('expenseParsers', () => {
  it('toNumber handles fallbacks', () => {
    expect(toNumber(100)).toBe(100);
    expect(toNumber("50.5")).toBe(50.5);
    expect(toNumber("invalid")).toBe(0);
    expect(toNumber(null)).toBe(0);
  });

  it('asNumberOrNull returns null for invalid', () => {
    expect(asNumberOrNull(100)).toBe(100);
    expect(asNumberOrNull("50.5")).toBe(50.5);
    expect(asNumberOrNull("invalid")).toBeNull();
  });

  it('isUuidLike detects uuids', () => {
    expect(isUuidLike("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuidLike("not-a-uuid")).toBe(false);
  });

  it('normalizeDateCandidate parses valid dates', () => {
    expect(normalizeDateCandidate("2026-01-01").getFullYear()).toBe(2026);
    expect(normalizeDateCandidate("invalid-date")).toBeNull();
  });

  it('leaseOverlapsFiscalYear handles active leases', () => {
    expect(leaseOverlapsFiscalYear({ start_date: "2024-01-01", end_date: "2028-12-31" }, 2026)).toBe(true);
    expect(leaseOverlapsFiscalYear({ start_date: "2027-01-01", end_date: "2028-12-31" }, 2026)).toBe(false);
  });

  it('isMissingColumnError handles various error shapes', () => {
    expect(isMissingColumnError({ code: "42703" })).toBe(true);
    expect(isMissingColumnError({ message: "Could not find the 'test' column" })).toBe(true);
    expect(isMissingColumnError({ code: "404" })).toBe(false);
  });
});
