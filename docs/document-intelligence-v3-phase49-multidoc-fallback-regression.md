# Enterprise Document Intelligence v3 - Phase 49 Multi-Document Fallback Regression

Date: 2026-07-15

Recommendation: **No Gate**

## Executive Summary

Phase 49 regression-tested the Phase 48B no-provider Lease Review fallbacks across the curated local/exported payload set. The test used only existing local JSON exports and the existing Lease Review normalizer. No deployment, remote read/write, provider call, parse rerun, extraction rerun, or production write occurred.

The assignment and Phase 45 base-lease regressions remained stable. The Craven CAM-heavy base lease showed the intended Phase 48B improvements for premises address, security deposit, CAM estimate, pro-rata expense/CAM rules, admin fee, and rent schedule rows. All uncertain fallback rows remain `needs_review`.

One regression/noise gap remains: Craven produced 34 Clause Records, while the Phase 49 expectation was that Clause Records remain intentionally non-noisy. This should be treated as a follow-up clause-record filtering/quality issue, not a reason to change the No Gate recommendation.

## Documents Tested

| Document | Uploaded File ID | Lease ID | Payload Source | Validity |
| --- | --- | --- | --- | --- |
| Approved assignment | fc8181e6-766d-49c7-b81b-b5d961160207 | 7b21f353-579d-48e8-b3dd-8e8c49743fe2 | uploaded_files export + leases export | valid curated assignment |
| Phase 45 base lease | f26f2cb5-4764-496c-a68f-484fc7a41085 | n/a | uploaded_files export only | valid curated base lease |
| Craven CAM-heavy base lease | 0155251a-b911-408c-ae83-469d8d6eb534 | n/a | uploaded_files export only | valid Craven Wings / Markets at Choto base lease |

## Per-Document Results

| Check | Approved Assignment | Phase 45 Base Lease | Craven CAM-Heavy Base Lease |
| --- | --- | --- | --- |
| resolved profile | assignment | base_lease | base_lease |
| approval readiness | needs_review | needs_review | needs_review |
| budget readiness | ready | blocked | blocked |
| CAM readiness | ready | needs_review | needs_review |
| hard missing fields | assignor_name only | lease_date, commencement_date, expiration_date, lease_term | lease_type, square_footage, commencement_date, expiration_date, monthly_rent, premises_use |
| assignment downgrades | applied correctly | not applied | not applied |
| fallback rows created | 0 | 0 | 16 |
| expense rules | 0 | 0 | 2 |
| CAM rules | 0 | 0 | 3 |
| rent schedule rows | 0 | 0 | 8 |
| clause records | 18 existing payload rows | 27 existing payload rows | 34 rows, noise review needed |
| duplicate CAM/expense rows | none | none | none |

## Assignment Regression

Expected behavior held.

- Profile resolves as `assignment`.
- Hard blocker remains `assignor_name` only.
- No base-lease budget/CAM blockers were applied.
- No Phase 48B CAM, rent, security, or premises fallback rows were created.
- Advisory gaps remain assignment-specific: original lease missing, tenant assignment advisory, and landlord consent assignment advisory.

## Phase 45 Base Lease Regression

Expected behavior held.

- Profile resolves as `base_lease`.
- Phase 46 alias behavior still holds: `premises_address` is not a missing approval blocker.
- Phase 48B fallback rules did not create noisy CAM, rent, security, or premises rows from unrelated text.
- Base-lease blockers remain active where source values are still genuinely missing.

## Craven CAM-Heavy Improvements

Expected Phase 48B fallback improvements mostly held.

| Area | Result |
| --- | --- |
| property address | `12350 South Northshore, Knoxville, TN 37922`, status `needs_review`, source page 1 |
| contact/notice address avoidance | tenant/contact address no longer used as premises address |
| security deposit | `$15,535.36`, status `needs_review`, source page 16 |
| CAM estimate | CAM rule: `$5.25 per leasable square foot`, status `needs_review`, source page 14 |
| pro-rata taxes | expense rule present, status `needs_review` |
| pro-rata insurance | expense rule present, status `needs_review` |
| pro-rata CAM | CAM rule present, status `needs_review` |
| admin/management fee | CAM rule present with 5 percent admin fee, status `needs_review` |
| rent schedule | 8 Rent Addendum schedule rows, status `needs_review` |
| monthly rent scalar | intentionally remains missing; schedule was not flattened |

Remaining expected gaps:

- `monthly_rent` scalar remains missing.
- `square_footage` remains missing.
- `commencement_date` remains missing.
- `expiration_date` remains missing.
- `lease_type` remains missing.
- `premises_use` remains missing.

## Noise Audit

| Audit Item | Result |
| --- | --- |
| duplicate CAM/expense rows | none found |
| fallback rows on assignment docs | none found |
| contact/notice address used as premises address | no for Craven; fallback selected premises address |
| uncertain fallback rows are reviewer-facing | yes, fallback rows are `needs_review` |
| evidence/source/page handling | honest but still incomplete in places |
| Clause Records non-noisy expectation | not met for Craven; 34 rows produced |

## Regression Finding

Regressions found: **yes, limited to Clause Records noise expectation**.

The normalizer output for Craven has `clauseRecordsCount = 34`. Phase 48B documentation expected Clause Records to remain conservative/non-noisy. Phase 49 therefore records this as a follow-up gap:

- inspect whether these 34 rows are coming from structured payload clauses, fallback dynamic rows, or table-derived records;
- filter low-value duplicate/generic clause rows;
- keep clause summaries evidence-backed and business-useful;
- do not make clause rows approval blockers.

## Verification

- Temporary runtime test fixture was used only for local normalizer execution and should be deleted before final handoff.
- Focused runtime check found the Clause Records mismatch.
- No source code changes were made for Phase 49.
- QA JSON parse check should pass after the QA report update.

## Recommended Phase 50

Run a narrow Clause Records quality/filtering phase for Lease Review output. Scope it to diagnostics and UI projection only: identify why Craven produces 34 clause rows, preserve useful evidence-backed clause summaries, remove generic/noisy duplicates, and keep approval behavior unchanged.

Recommendation remains: **No Gate**.
