# Lease Extraction Evaluation Runbook

Stage B adds a repository-integrated evaluator for adjudicated lease extraction ground truth. It extends the existing `benchmarks/` convention rather than adding a second extraction pipeline.

## Reused Repository Infrastructure

- `benchmarks/` layout for manifests, expected fixtures, replay artifacts, and reports.
- `package.json` script convention used by existing benchmark commands.
- `src/lib/leaseFieldContract.js` for canonical field keys, aliases, and field domains.
- Vitest under `src/lib/__tests__` for scorer regression coverage.
- Existing report pattern: machine-readable JSON plus human-readable HTML/Markdown artifacts.

## Files

- Manifest: `benchmarks/lease-extraction/manifest.json`
- Schema: `benchmarks/lease-extraction/schemas/lease-ground-truth-v1.schema.json`
- Golden fixtures: `benchmarks/lease-extraction/golden/*.ground-truth.json`
- Replay outputs: `benchmarks/lease-extraction/replay/*.review-payload.json`
- Reports: `benchmarks/lease-extraction/reports/latest/`
- Baseline: `benchmarks/lease-extraction/baselines/latest/`

## Commands

```bash
npm run lease-eval
npm run lease-eval -- --fixture macon-crossing-tnn-2019 --actual path/to/captured-review-payload.json
npm run lease-eval -- --report-json
npm run lease-eval -- --fixture macon-crossing-tnn-2019 --actual path/to/captured-review-payload.json --update-baseline
npm run lease-eval:ci
```

Standard CI currently uses `--smoke` to validate scorer wiring because no captured Macon pipeline output is committed yet. Accuracy evaluation must use replay mode with a captured pipeline review payload supplied by `--actual <path>` or by adding `replayActualFixture` to the manifest. Live evaluation is intentionally not mixed with replay output. To score a live extraction later, capture the produced review payload as a versioned replay artifact first, including provider/model/prompt metadata.

## Fixture Adjudication Workflow

1. Reviewer A prepares expected fields, structured rules, forbidden extractions, evidence pages and notes.
2. Reviewer B independently reviews the same source document.
3. The benchmark owner compares reviewer outputs by canonical key, scope, value, domain and evidence.
4. An adjudicator resolves disagreements and records rationale in `adjudication.notes`.
5. Accepted alternative values are stored in `acceptedAlternativeValues`.
6. Use `not_stated` when the lease is silent and `not_applicable` when the concept cannot apply to the document.
7. Page evidence should include stable text snippets until Azure span IDs are available.
8. Schema changes require fixture migration and a note in `adjudication.notes`.
9. Legal interpretation notes stay in fixture `notes`; do not inject fixture text into runtime prompts.
10. Only locked, independently reviewed fixtures may count toward Level 2 target gates.

## Scoring

Precision = true positive supported facts / all automatically extracted facts.

Recall = true positive supported facts / supported ground-truth value facts.

F1 = harmonic mean of precision and recall.

Critical precision, recall and F1 are computed over fields marked `critical`.

The evaluator separately reports:

- unsupported auto-fills
- missed facts
- wrong-domain evidence
- missing evidence
- duplicate canonical rows
- conflict detection
- abstentions
- failure stage classification

## Thresholds

Level 1 no-regression gates are enabled immediately:

- unsupported critical auto-fills must not increase
- duplicate canonical rows must be zero
- wrong-domain critical evidence must be zero
- critical precision must not decrease when a baseline is supplied

Level 2 target gates are disabled until the corpus has at least 12 fixtures, 4 property types and 5 document types:

- overall F1 >= 95%
- critical precision >= 98%
- unsupported critical auto-fills = 0
- canonical duplicates = 0
- wrong-domain critical evidence accepted = 0

## Macon Fixture Status

`macon-crossing-tnn-2019` is a bootstrap fixture derived from the supplied prompt facts. Its replay artifact is a scorer smoke artifact, not a live extraction run. It must receive independent human review and a captured live/replay pipeline output before it can support production accuracy claims.

## Remaining Stage C Gate

Before Stage C structured-domain persistence, add independently adjudicated fixtures for native digital lease, full-service gross lease, modified-gross base-year lease, NNN lease, office lease, industrial lease, retail shopping-center lease, amendment, assignment, commencement letter, CAM reconciliation, controllable-expense cap, gross-up, complex insurance, poor OCR scan, handwriting-heavy lease, missing-page document and conflicting amendment chain.
