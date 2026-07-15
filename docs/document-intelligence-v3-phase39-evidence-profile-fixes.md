# Document Intelligence v3 — Phase 39 Evidence-Integrity Bug Fixes + Profile Detection Reconciliation

Generated: 2026-07-15

## 1. Executive Summary

Phase 39 fixed the three bugs Phase 38's code + local data verification found
in the approved assignment document, entirely within the user-facing Lease
Review normalizer/UI path (no pipeline, edge-function, or extractor changes):

1. Split-brain profile detection between `detectDocumentProfile()` and
   `currentReviewPolicy.profile` — **fixed**.
2. Signature dates (`tenant_signature_date`, `landlord_signature_date`)
   accepted from original-lease-reference text — **fixed**.
3. `landlord_name` resolving to the literal string `"<figure>"` — **fixed**.

All three fixes were verified against the real approved local data by
re-running the real, unmodified `normalizeLeaseReviewData()` production
function (same method as Phase 38, since no browser automation tool is
available in this environment either). The approval-blocker set is
unchanged (`assignor_name` remains the only hard blocker) — none of these
fixes altered approval-gating behavior.

Extraction Mode (column + underlying data model) remains explicitly out of
scope and untouched — deferred to Phase 40 in full, including as noted in
the plan's guardrails: no column, no data-model change, not even a small hook.

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

## 4. Bug 1 — Split-Brain Profile Detection

### Reproduction

`src/pages/LeaseReview.jsx`'s `isAssignmentOnlyDocument` called
`detectDocumentProfile(leaseFull)` (`src/lib/documentProfile.js`) directly
and checked membership in 4 legacy tokens. `detectDocumentProfile` only
checks a small set of primary payload paths
(`workflow_output.document_profile.documentType` etc.) before falling back
to `"unknown"`. The separate `currentReviewPolicy.profile`
(`src/lib/leaseReviewCurrentPolicy.js`, `resolveCurrentReviewProfile`) calls
`detectDocumentProfile` first too, but on `"unknown"` falls through to a
much wider candidate scan (`collectProfileCandidates`) and correctly finds
the assignment signal via a different payload path
(`lease.document_profile`). For the approved document this meant
`detectDocumentProfile` returned `"unknown"` while `currentReviewPolicy.profile`
correctly returned `"assignment"` — and since `isAssignmentOnlyDocument`
gated the assignment banner and `FULL_LEASE_ONLY_TABS` hiding, those didn't
engage even though blocker logic was correct.

Reproduced with a fixture-level test (`leaseReviewCurrentPolicy.test.js`)
that sets only `lease.document_profile` and confirms
`detectDocumentProfile(fixture) === "unknown"` while
`buildCurrentReviewPolicy(fixture).profile === "assignment"` on the same
object.

### Fix

`src/pages/LeaseReview.jsx`: `isAssignmentOnlyDocument` now derives from
`normalized.currentReviewPolicy?.profile === "assignment"` instead of
calling `detectDocumentProfile` directly. `normalized` (from
`normalizeLeaseReviewData`) is already computed earlier in the component, so
no reordering was needed. The now-unused `detectDocumentProfile` import was
removed. `currentReviewPolicy.profile === "assignment"` correctly subsumes
the old 4-token check (amendment/estoppel/consent already fold into
`"assignment"` in `normalizeCurrentReviewProfile`), and gains the wider
candidate-scan fallback. Base-lease behavior is preserved unchanged:
`resolveCurrentReviewProfile` still calls `detectDocumentProfile` first and
short-circuits on its full-lease-signal override, so a genuine full lease
(or a reviewer's "mark as full lease" override) still resolves to
`"base_lease"`.

No other file needed changes. `leaseRulePipelineService.js`'s
`detectDocumentProfile` is a same-named, unrelated function from a different
module (CAM rule-extraction text diagnostics) — confirmed out of scope, not
a third profile system.

## 5. Bug 2 — Signature-Date Evidence Integrity

### Reproduction

`tenant_signature_date`/`landlord_signature_date` resolved to
`2018-02-01` with `status: "auto_populated"`, `evidenceVerified: true`, but
the source text ("...entered into that certain Lease dated February 1,
2018") describes the original lease's date, not this document's signature.
Reproduced with the real document's exact source text in
`leaseReviewFieldNormalizer.test.js`.

### Fix

Added `isSignatureDateSourcedFromLeaseReference(sourceText)` to
`src/lib/leaseReviewFieldNormalizer.js`: a pattern match for lease-reference
phrasing ("entered into ... Lease", "that certain Lease dated", "pursuant
to ... Lease", etc.) that is *not* also accompanied by execution-context
phrasing ("IN WITNESS WHEREOF", "executed ... as of", "/s/", etc.). Scoped
to exactly `tenant_signature_date`/`landlord_signature_date` via an explicit
`Set` — not a general date-field rule. When it fires inside
`normalizeStandardFields`, `evidenceVerified` is forced `false` and a
`validationMessage` explains why; the **value is retained**, not
fabricated away — `computeFieldStatus`'s existing
`evidenceVerified && confidenceBucket === "high" → auto_populated`
/ `else → needs_review` branch naturally demotes status without any changes
to that function. Since the value stays non-null, this fix does not touch
`missingFields`/blocker computation at all.

## 6. Bug 3 — Invalid Markup Value

### Reproduction

`landlord_name` resolved to the literal string `"<figure>"`, displayed as
if it were a real extracted value. Reproduced with the real document's
exact source text in `leaseReviewFieldNormalizer.test.js`.

### Fix

Added `isMarkupArtifactValue(value)` to `src/lib/leaseReviewSchema.js`: a
narrow regex matching a value that *is entirely* one bare HTML/XML tag
(`<figure>`, `</figure>`, `<table>`, `<tr>`, `<td>`, etc.) — doesn't match
real text that merely contains a `<` character. Applied generically to every
field in `normalizeStandardFields` (not landlord_name-specific): when it
fires, `value` is nulled, `evidenceVerified` is forced `false`,
`invalidValueRejected` is set `true` on the row, and `validationMessage`
explains the rejection. Raw payload data is untouched — this only affects
the client-rendered row.

### The blocker-carve-out design decision

Nulling `landlord_name`'s value fixes the display bug, but `landlord_name`
was already in the assignment profile's `requiredFieldKeys` (it has
signal via its source text). The exact same `isMeaningfulValue(row.value)`
check that determines display status is also read by
`normalizeApprovalBlockers` and `buildReadinessSummary`'s `hasRowValue()` to
decide the blocker/completeness lists — so naively nulling the value would
have turned `landlord_name` into a **second** hard blocker alongside
`assignor_name`, changing the signed-off blocker set as an unintended side
effect of a display fix.

Per explicit user decision, this was resolved with a narrow, single-purpose
carve-out: `invalidValueRejected` is set at **exactly one place** (inside
`normalizeStandardFields`'s markup-rejection branch) and is read at exactly
two places — `hasRowValue()` and `normalizeApprovalBlockers`'s two
`missingFields`-push sites (the main `LEASE_FIELD_CONTRACT` loop and the
supplementary `policyRequiredKeys` pass) — each with an
`|| row.invalidValueRejected === true` addition and an explanatory comment.
It is additive only: a genuinely, independently missing field never has
`invalidValueRejected: true`, so this cannot mask a real gap. It is not a
general "field is fine" predicate and does not touch any other bug fix in
this phase (the signature-date fix in Bug 2 retains its value and never
sets or reads this flag).

## 7. Files Changed

| File | Change |
| --- | --- |
| `src/pages/LeaseReview.jsx` | `isAssignmentOnlyDocument` now derives from `currentReviewPolicy.profile`; removed unused `detectDocumentProfile` import |
| `src/lib/leaseReviewSchema.js` | Added `isMarkupArtifactValue()` |
| `src/lib/leaseReviewFieldNormalizer.js` | Added `isSignatureDateSourcedFromLeaseReference()`; `normalizeStandardFields` rejects markup artifacts and demotes lease-reference-sourced signature dates; `hasRowValue()` and `normalizeApprovalBlockers()` carry the narrow `invalidValueRejected` carve-out |
| `src/lib/__tests__/leaseReviewCurrentPolicy.test.js` | 4 new tests (Phase 39 profile reconciliation) |
| `src/lib/__tests__/leaseReviewFieldNormalizer.test.js` | 8 new tests (Phase 39 signature-date + invalid-markup) |
| `docs/document-intelligence-v3-phase39-evidence-profile-fixes.md` | New (this file) |
| `docs/document-intelligence-v3-batch-audit-qa.md` | Phase 39 section appended |
| `docs/document-intelligence-v3-batch-audit-qa.json` | `phase39_...` object appended |

## 8. Tests Added

| File | New tests |
| --- | ---: |
| `leaseReviewCurrentPolicy.test.js` | 4 |
| `leaseReviewFieldNormalizer.test.js` | 8 |
| **Total new** | **12** |

Covering: split-brain reproduction, source-level reconciliation proof, base
lease preserved, unknown-profile preserved; signature-date bug reproduction
(both fields), valid-signature-date-preserved case, direct predicate unit
coverage; invalid-markup bug reproduction, valid-value-preserved case,
direct predicate unit coverage, and the no-new-blocker regression test.

## 9. Phase 38-Style Rerun Result

Re-ran the real `normalizeLeaseReviewData()` against the approved local rows
(fresh read-only dump from local Postgres, temporary Vitest file deleted
immediately after — no browser tool available in this session either):

| Check | Before Phase 39 | After Phase 39 |
| --- | --- | --- |
| `detectDocumentProfile(leaseFull)` | `"unknown"` | `"unknown"` (unchanged — this function itself is untouched) |
| `currentReviewPolicy.profile` | `"assignment"` | `"assignment"` |
| `isAssignmentOnlyDocument` would resolve to | `false` (bug) | `true` (fixed) |
| `landlord_name` value | `"<figure>"` | `null` |
| `landlord_name` status | `needs_review` | `missing` |
| `landlord_name` validationMessage | none | "Extracted value `\"<figure>\"` was a layout/markup artifact, not a real field value, and was rejected." |
| `tenant_signature_date` status | `auto_populated` | `needs_review` |
| `tenant_signature_date` evidenceVerified | `true` | `false` |
| `tenant_signature_date` value | `"2018-02-01"` | `"2018-02-01"` (retained) |
| `landlord_signature_date` status | `auto_populated` | `needs_review` |
| `landlord_signature_date` evidenceVerified | `true` | `false` |
| `approvalBlockers.missingFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `readinessSummary.missingRequiredFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `advisoryGaps` (tenant_name, landlord_consent, original_lease_missing) | present | present (unchanged) |
| `budgetReadiness` / `camReadiness` | `ready` / `ready` | `ready` / `ready` (unchanged) |

Table contract (Type column absent, action dropdown present) was not
touched this phase — reconfirmed by inspection that
`LeaseReviewTabTable.jsx` has no diff.

## 10. Remaining Gaps

- **Extraction Mode column/data model** — still missing, explicitly deferred
  to Phase 40 in full (no column, no data-model change was made this phase).
- `tenant_name` remains source-less/needs-review (pre-existing, correct
  behavior, not a bug — consistent with Phases 30/34/37/38).
- `landlord_consent` shows `evidenceVerified: false` despite clear-looking
  source text — pre-existing behavior from the generic evidence-quality
  resolver, not touched or diagnosed further in this phase (out of the three
  named bugs).
- The `landlord_name` no-new-blocker carve-out is a deliberate, narrow,
  revisit-able decision — a future phase should have business/legal
  explicitly decide whether an invalid-value-rejected required field should
  become a hard blocker outright.

## 11. Verification

| Check | Result |
| --- | --- |
| `npm run lint` | passed, no errors |
| `npm run typecheck` | passed, no errors |
| `npm run build` | passed with pre-existing Vite chunk-size warnings only |
| `npm run test` | passed, 55 files / 602 tests (590 prior + 12 new) |
| Focused: `leaseReviewCurrentPolicy.test.js` | 13/13 passed |
| Focused: `leaseReviewFieldNormalizer.test.js` | 22/22 passed |
| `leaseReviewTabTableContract.test.js` / `leaseReviewUiState.test.js` | passed (untouched this phase, included in full suite) |

## 12. Recommendation

**No Gate.** All three Phase 38 bugs are fixed without changing
approval-gating behavior, persisted approval state, or base-lease behavior.
Extraction Mode remains the only known outstanding gap, fully deferred to
Phase 40.

## 13. Recommended Phase 40

Scope and implement the Extraction Mode column and its underlying data
model: (1) decide how explicit/inferred/calculated/reviewer-entered should
be tracked per field (today only expense/CAM rule-derived fields ever get
stamped `"calculated"`; most standard fields carry no such tag), which may
require extractor-side (provider-backed) support beyond a client-only fix;
(2) render the resulting value as an 8th `Extraction Mode` table column once
the data model exists. Do not conflate this with approval-gating changes.
