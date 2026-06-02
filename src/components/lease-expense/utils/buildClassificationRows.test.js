import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  humanize,
  toNumber,
  buildAmountBuckets,
  leaseCoversYear,
  isClassificationSentToCam
} from './buildClassificationRows';

describe('buildClassificationRows', () => {
  it('normalizeText lowercases and trims', () => {
    expect(normalizeText("  HeLLo  ")).toBe("hello");
  });

  it('humanize formats strings', () => {
    expect(humanize("test_key")).toBe("Test Key");
  });

  it('toNumber parses and falls back to 0', () => {
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber("invalid")).toBe(0);
    expect(toNumber(null)).toBe(0);
  });

  it('buildAmountBuckets distributes correctly', () => {
    const recoverable = buildAmountBuckets(100, "recoverable");
    expect(recoverable.recoverable_amount).toBe(100);
    expect(recoverable.non_recoverable_amount).toBe(0);

    const nonRecoverable = buildAmountBuckets(50, "non_recoverable");
    expect(nonRecoverable.non_recoverable_amount).toBe(50);
  });

  it('leaseCoversYear checks overlap correctly', () => {
    expect(leaseCoversYear({ start_date: "2020-01-01", end_date: "2025-12-31" }, 2024)).toBe(true);
    expect(leaseCoversYear({ start_date: "2020-01-01", end_date: "2025-12-31" }, 2026)).toBe(false);
  });

  it('isClassificationSentToCam detects sent status', () => {
    expect(isClassificationSentToCam({ sent_to_cam: true })).toBe(true);
    expect(isClassificationSentToCam({ cam_status: 'cam_ready' })).toBe(true);
    expect(isClassificationSentToCam({ cam_status: 'needs_review' })).toBe(false);
  });
});
