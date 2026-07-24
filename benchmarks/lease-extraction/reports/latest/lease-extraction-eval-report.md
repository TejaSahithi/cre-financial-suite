# Lease Extraction Evaluation Report

Generated: 2026-07-24T19:55:22.166Z
Run mode: scorer_smoke
Fixtures: 1
Corpus sufficiency: insufficient_for_level_2_target_gate

## Summary Metrics

- Precision: 100.00%
- Recall: 100.00%
- F1: 100.00%
- Critical precision: 100.00%
- Critical recall: 100.00%
- Unsupported critical auto-fills: 0
- Duplicate canonical rows: 0
- Wrong-domain evidence facts: 0

## Thresholds

| Level | Gate | Status | Actual | Threshold |
| --- | --- | --- | --- | --- |
| 1 | unsupportedCriticalAutoFillsNotIncrease | pass | 0.0000 | <= 0.0000 |
| 1 | duplicateCanonicalRowsZero | pass | 0.0000 | <= 0.0000 |
| 1 | wrongDomainCriticalEvidenceZero | pass | 0.0000 | <= 0.0000 |
| 1 | criticalPrecisionNotDecrease | pass | 1.0000 | >= 1.0000 |
| 2 | overallF1Target (disabled) | pass | 1.0000 | >= 0.9500 |
| 2 | criticalPrecisionTarget (disabled) | pass | 1.0000 | >= 0.9800 |
| 2 | unsupportedCriticalAutoFillsZero (disabled) | pass | 0.0000 | <= 0.0000 |
| 2 | canonicalDuplicatesZero (disabled) | pass | 0.0000 | <= 0.0000 |
| 2 | wrongDomainCriticalEvidenceZero (disabled) | pass | 0.0000 | <= 0.0000 |

## Known Failures By Stage

- macon-crossing-tnn-2019: no field-level failures in this run artifact.

Note: Smoke-mode metrics validate scorer wiring only. They are not extraction accuracy metrics.
