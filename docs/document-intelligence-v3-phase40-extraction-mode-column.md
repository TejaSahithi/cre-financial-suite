# Document Intelligence v3 — Phase 40 Extraction Mode Column + Data Model

Generated: 2026-07-15

## 1. Executive Summary

Phase 40 closed the last known Phase 38 requirements-contract gap: the Lease
Review tab table now has an 8th `Extraction Mode` column, backed by a real
(not fabricated) `extractionMode` value on every standard field row, computed
by a new `resolveLeaseReviewExtractionMode()` resolver from signals that were
already being computed (extraction status, evidence quality, review status)
— not invented for this phase.

No provider calls, no extraction rerun, no approval-gating change. The
approved document's blocker set (`assignor_name` only) and readiness
(`budgetReadiness`/`camReadiness: "ready"`) are unchanged.

Recommendation remains: **No Gate**.

## 2. Approved IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## 3. Constraints Honored

No deploy, no remote read, no production write, no secrets/service-key use,
no `SUPABASE_ACCESS_TOKEN`, no Azure call, no Vertex/Gemini call, no parse
rerun, no extraction rerun, no `vertex_fact_ledger` global enablement, no
`BUSINESS_EXTRACTION_PROVIDER` change, no v3 advisory hard gate, no
persisted-approval-state change, no weakening of base-lease behavior.

## 4. Task A — Existing Row Data Model (Inspection Findings)

Before writing any code, the following was confirmed by reading
`leaseReviewFieldNormalizer.js`, `leaseReviewSchema.js`,
`LeaseReviewTabTable.jsx`, and `LeaseReview.jsx`:

- Rows are built in `normalizeStandardFields()` (`leaseReviewFieldNormalizer.js`),
  one row per `LEASE_FIELD_CONTRACT` entry, from `readFieldValue`/
  `readFieldEvidence`/`readFieldConfidence`/`resolveExtractionStatus`/
  `hasValidSourceEvidence` (all in `leaseReviewSchema.js`).
- **No existing row property represented "extraction mode" as its own
  concept.** `EXTRACTION_STATUSES` conflates status and mode into one enum
  (`calculated`/`derived`/`inferred` sit alongside `needs_review`/`missing`);
  only expense/CAM rule-derived fields ever got stamped `"calculated"`.
- Rich, reusable signals already existed that Phase 40 could ground a real
  resolver in without fabricating anything: `resolveExtractionStatus()`
  (returns `calculated`/`inferred`/`manual*`/`extracted`/etc.),
  `resolveSourceTextQuality()` (returns `exact`/`partial`/`derived`/
  `inferred`/`missing`/`conflict`/`inconsistent`), `hasValidSourceEvidence()`,
  and `isCalculatedExtractionStatus()`/`isManualExtractionStatus()`.
- Reviewer status vocabulary (`REVIEW_STATUSES`: pending, accepted, edited,
  rejected, not_applicable, needs_legal_review, manual_required) already
  distinguishes a human-edited value (`EDITED`) from a human-flagged one
  (`MANUAL_REQUIRED`) from an accepted-as-is value (`ACCEPTED`).
- Accept/Edit/Mark N/A/Needs Review/Reject update `fieldReviews[key].status`
  in `LeaseReview.jsx` (`handleAccept`/`handleReject`/`handleMarkNA`/
  `handleNeedsLegal`), read back into `normalizeStandardFields` via the
  `fieldReviews` parameter — this is what feeds `reviewStatus` into the new
  resolver.
- `LeaseReviewTabTable.jsx` renders 7 columns (`Field / Term, Value, Status,
  Confidence, Page, Source Text, Action`) from local `TYPE_META`/`STATUS_META`
  presentation maps — no server round-trip, purely a rendering layer over the
  rows the normalizer already built.

## 5. Task B — Extraction Mode Vocabulary

Added as `EXTRACTION_MODES` / `EXTRACTION_MODE_LABELS` in
`src/lib/leaseReviewSchema.js`, alongside the existing `EXTRACTION_STATUSES`/
`REVIEW_STATUSES`/`SOURCE_TEXT_QUALITIES` vocabularies:

| Mode | Definition |
| --- | --- |
| `explicit` | Directly stated in the source text, with usable evidence. |
| `normalized` | Derived from a directly stated value through formatting/date/currency/name-cleanup or equivalent non-substantive transformation. |
| `inferred` | Inferred from context, not directly stated. |
| `calculated` | Computed from other extracted values. |
| `reviewer_entered` | Entered or corrected by a human reviewer. |
| `manual` | Manually marked/overridden without enough structured detail to classify as reviewer_entered. |
| `unknown` | The system cannot safely determine the extraction mode. |

## 6. Task C — `resolveLeaseReviewExtractionMode()`

Added to `src/lib/leaseReviewFieldNormalizer.js`. Signature:
`resolveLeaseReviewExtractionMode({ hasValue, extractionStatus, evidenceVerified, evidence, reviewStatus, invalidValueRejected, evidenceOverrideReason })`.

Resolution order (every branch grounded in an already-computed, real
signal — never fabricated):

1. `reviewStatus === REVIEW_STATUSES.EDITED` → `reviewer_entered` (a human
   provided/changed the value content).
2. `reviewStatus === REVIEW_STATUSES.MANUAL_REQUIRED` or
   `isManualExtractionStatus(extractionStatus)` → `manual`.
3. `invalidValueRejected` (Phase 39 `<figure>`-style rejection) or
   `evidenceOverrideReason` set (Phase 39 signature-date-from-original-lease
   demotion) → `unknown` — **never** explicit/normalized/inferred for a
   value the system just finished saying it doesn't trust.
4. `!hasValue` → `unknown` (nothing to describe a mode for).
5. `isCalculatedExtractionStatus(extractionStatus)` → `calculated`.
6. `extractionStatus === EXTRACTION_STATUSES.INFERRED` → `inferred`.
7. `!evidenceVerified` → `unknown` (no valid source evidence backing this
   value at all).
8. `resolveSourceTextQuality(evidence)`: `exact`/`partial` → `explicit`;
   `derived` → `normalized`; `inferred` → `inferred`; anything else →
   `unknown`.

This directly satisfies every "do not" rule in the task brief: it never
claims explicit from a bare value, from missing/invalid evidence, from a
rejected markup artifact, or from a signature date sourced from the original
lease date — each of those is intercepted before the evidence-quality check
ever runs.

## 7. Task D — Wiring `extractionMode` Onto Rows

- **Standard field rows** (`normalizeStandardFields`): full resolver output,
  using the exact `hasValue`/`extractionStatus`/`evidenceVerified`/
  `evidence`/`review?.status`/`invalidValueRejected`/`evidenceOverrideReason`
  already computed in that function for status/evidence purposes. Exposed
  as both `extractionMode` and `extraction_mode`.
- **Critical dates** (`normalizeCriticalDates`) and **budget preview /
  read-only-reference rows** (`toReadOnlyReference` in `buildRowsByTab`):
  no separate wiring needed — both pick/spread the original standard field
  row object, so `extractionMode` propagates automatically. Verified this
  is real (not accidental) via a dedicated test: a `commencement_date` with
  clean evidence resolves `explicit` in both `standardFields` and
  `criticalDates`.
- **Dynamic findings, clause records, expense/CAM rule rows**: set to
  `EXTRACTION_MODES.UNKNOWN` explicitly, with a comment explaining why —
  these row types don't carry the same structured extraction-status/
  evidence-quality metadata standard fields do (no `resolveExtractionStatus`-
  compatible shape), so resolving a real mode for them would mean guessing.
  This is exactly the escape hatch the task brief names ("for existing rows
  without enough metadata, use unknown") and is called out as a Phase 41+
  follow-up opportunity below, not a defect.
- Raw payloads are untouched — `extractionMode` is a client-computed,
  presentation-layer property only.

## 8. Task E — Extraction Mode Column

`src/components/lease-review/LeaseReviewTabTable.jsx`:

- New header `Extraction Mode` inserted between `Confidence` and `Page`.
  Column order is now: `Field / Term, Value, Status, Confidence, Extraction
  Mode, Page, Source Text, Action` (8 columns).
- New local `EXTRACTION_MODE_META` presentation map (mirrors the existing
  `STATUS_META`/`TYPE_META` pattern) renders `row.extractionMode` as a
  badge, defaulting to `Unknown` styling for any unrecognized/missing value.
- `colSpan={7}` → `colSpan={8}` on the empty-state row.
- Type column: unchanged, still not rendered (`TYPE_META` remains
  filter-only, as fixed in Phase 36).
- Action dropdown: unchanged — Accept/Edit/Mark Needs Review/Mark N/A/
  Reject/View Source all still present and wired to the same handlers.

## 9. Task F — Preserved Behavior

Not touched this phase: profile-aware blockers (`leaseReviewCurrentPolicy.js`
untouched), assignment policy, approval-blocker logic (`normalizeApprovalBlockers`
only read `evidence`/`extractionStatus` for the new mode computation — its
own blocker logic is unchanged), readiness logic (`buildReadinessSummary`
untouched), enrichment banner logic (`leaseReviewUiState.js` untouched),
debug/admin gating (`LeaseReview.jsx`'s `isSuperAdminUser` gate untouched),
Accept/Edit persistence behavior (`handleAccept`/`handleReject`/etc.
untouched).

## 10. Task G — Tests Added

| File | New tests |
| --- | ---: |
| `leaseReviewFieldNormalizer.test.js` | 10 |
| `leaseReviewTabTableContract.test.js` | 3 |
| **Total new** | **13** |

Covering: explicit requires real evidence (not just a value); no evidence →
unknown, not explicit; rejected markup artifact → unknown, never explicit;
signature date sourced from original lease → unknown, never explicit;
reviewer-edited → `reviewer_entered`; manual-required review status →
`manual`; backend-tagged calculated/manual/inferred extraction statuses map
correctly; the safe "unknown" default across every under-specified input
shape; non-standard row types (dynamic/clause/expense/CAM) default to
`unknown` rather than a guessed mode; critical-dates/budget-preview rows
inherit the real (non-`unknown`) mode from their source standard field;
Extraction Mode column renders; Type column stays hidden; column order is
exactly as specified; empty-state `colSpan` matches the new 8-column layout.
All prior Phase 39 tests (profile reconciliation, signature-date fix,
invalid-markup fix, no-new-blocker regression) still pass unmodified.

## 11. Task H — Phase 38-Style Local Data Verification

Re-ran the real `normalizeLeaseReviewData()` against the approved local rows
(fresh read-only local Postgres dump, temporary Vitest file deleted after —
no browser tool available in this session either):

| Check | Result |
| --- | --- |
| `extractionMode` present on relevant rows | yes, on all 88 standard field rows |
| `landlord_name` (rejected `<figure>` artifact) | `extractionMode: "unknown"` — not explicit |
| `tenant_signature_date` (sourced from original lease date) | `extractionMode: "unknown"` — not explicit |
| `landlord_signature_date` (sourced from original lease date) | `extractionMode: "unknown"` — not explicit |
| `assignee_name` (clean, page-anchored evidence) | `extractionMode: "explicit"` |
| `assignment_effective_date` (clean, page-anchored evidence) | `extractionMode: "explicit"` |
| `security_deposit` (clean, page-anchored evidence) | `extractionMode: "explicit"` |
| `tenant_name` (weak/unverified evidence) | `extractionMode: "unknown"` — correctly not overclaimed |
| `landlord_consent` (evidence present but `evidenceVerified: false`) | `extractionMode: "unknown"` — correctly not overclaimed |
| `assignor_name` (no value at all) | `extractionMode: "unknown"` (nothing to describe a mode for) |
| Extraction mode distribution across 88 standard fields | 11 `explicit`, 77 `unknown` (most fields on this document are simply missing/not modeled as calculated — see §12) |
| `approvalBlockers.missingFields` | `["assignor_name"]` — unchanged from Phase 39 |
| `readinessSummary.missingRequiredFields` | `["assignor_name"]` — unchanged |
| `budgetReadiness` / `camReadiness` | `ready` / `ready` — unchanged |
| Original lease missing | still advisory/current-truth (unchanged) |
| Type column | absent (unchanged, not touched this phase) |
| Action dropdown | intact (unchanged, not touched this phase) |

## 12. Remaining Unknown-Mode Fields

Of the 7 populated (non-null) fields that resolve to `unknown` on this
document: `status`, `tenant_name`, `lease_term_months`,
`landlord_consent`, `all_other_terms_remain_same`, `tenant_signature_date`,
`landlord_signature_date`. Two of these (`tenant_signature_date`,
`landlord_signature_date`) are `unknown` *by design* (Phase 39's evidence
rejection — correct, not a gap). The rest (`tenant_name`,
`landlord_consent`, `status`, `lease_term_months`,
`all_other_terms_remain_same`) are `unknown` because their evidence doesn't
clear `evidenceVerified`/`resolveSourceTextQuality`'s bar for this document
— consistent with their pre-existing `needs_review` status from Phases
30/34/37/38; this is the resolver correctly declining to overclaim, not a
new defect.

The 77 fields with no value at all are trivially `unknown` (nothing to
describe a mode for) — this is expected for an assignment document that
doesn't populate most base-lease economics/CAM fields.

## 13. Remaining Gaps / Phase 41 Candidates

- Dynamic findings, clause records, and expense/CAM rule rows are `unknown`
  by design this phase (insufficient structured metadata to resolve safely).
  A future phase could extend the resolver to these row types if their
  source data gets a compatible evidence-quality shape.
- No mechanism yet marks a value `calculated` for anything beyond the
  existing rule-derived expense/CAM fields (`isCalculatedExtractionStatus`)
  — most standard fields simply never get a calculated/inferred tag from the
  backend today, so they can only ever resolve to `explicit`/`unknown` in
  practice. Broader `calculated`/`inferred` coverage would need
  extractor-side (provider-backed) changes, out of scope here.

## 14. Files Changed

| File | Change |
| --- | --- |
| `src/lib/leaseReviewSchema.js` | Added `EXTRACTION_MODES`, `EXTRACTION_MODE_LABELS` |
| `src/lib/leaseReviewFieldNormalizer.js` | Added `resolveLeaseReviewExtractionMode()`; wired `extractionMode`/`extraction_mode` onto standard field rows (full resolver) and dynamic/clause/expense/CAM rows (`unknown` default) |
| `src/components/lease-review/LeaseReviewTabTable.jsx` | Added `Extraction Mode` column + `EXTRACTION_MODE_META` presentation map; `colSpan` 7→8 |
| `src/lib/__tests__/leaseReviewFieldNormalizer.test.js` | 10 new tests |
| `src/lib/__tests__/leaseReviewTabTableContract.test.js` | 3 new tests |
| `docs/document-intelligence-v3-phase40-extraction-mode-column.md` | New (this file) |
| `docs/document-intelligence-v3-batch-audit-qa.md` | Phase 40 section appended |
| `docs/document-intelligence-v3-batch-audit-qa.json` | `phase40_...` object appended |

`src/lib/leaseReviewCurrentPolicy.js`, `src/pages/LeaseReview.jsx` — **not
modified this phase** (Task F preservation confirmed by inspection and by
the unmodified Phase 39 tests still passing).

## 15. Verification

| Check | Result |
| --- | --- |
| `npm run lint` | passed, no errors |
| `npm run typecheck` | passed, no errors |
| `npm run build` | passed with pre-existing Vite chunk-size warnings only |
| `npm run test` | passed, 55 files / 615 tests (602 prior + 13 new) |
| Focused: `leaseReviewFieldNormalizer.test.js` | 32/32 passed |
| Focused: `leaseReviewTabTableContract.test.js` | 5/5 passed |
| Focused: `leaseReviewCurrentPolicy.test.js` | 13/13 passed |
| Focused: `leaseReviewUiState.test.js` | 1/1 passed |

## 16. Recommendation

**No Gate.** Extraction Mode column and data model are added without
changing approval-gating behavior, persisted approval state, base-lease
behavior, or any Phase 33-39 fix. Extraction mode coverage is honest (11
explicit / 77 unknown for this document) rather than inflated.

## 17. Recommended Phase 41

Business/legal review of the extraction-mode vocabulary and coverage:
confirm the `unknown` default is acceptable for dynamic findings/clause
records/expense-CAM rules for now, and decide whether broader
`calculated`/`inferred` coverage for standard fields is worth extractor-side
(provider-backed) investment, versus leaving the current conservative,
never-fabricated behavior as the permanent baseline.
