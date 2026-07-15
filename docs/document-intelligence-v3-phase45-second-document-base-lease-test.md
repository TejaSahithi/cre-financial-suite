# Document Intelligence v3 — Phase 45: Second Document Test (Base Lease)

## Goal

Prove the profile-aware Lease Review policy generalizes beyond the single
approved assignment document (`fc8181e6-766d-49c7-b81b-b5d961160207` /
lease `7b21f353-579d-48e8-b3dd-8e8c49743fe2`, used in every phase from
Phase 26 through 44A-Fix) by testing it against a second, genuinely
different document — a full base lease.

## Candidate Search

No second document existed in the local database — a read-only query
confirmed the local `uploaded_files`/`leases` tables contain only the one
approved assignment document for this org. Per the phase brief, no
production scan was performed; the user was asked to provide/export a
candidate.

Two rounds were needed to get a genuine candidate:

1. The user's first export was, on inspection, the **same** assignment
   document re-exported (`fc8181e6-...` / `7b21f353-...`,
   `document_subtype: "assignment"`). This was flagged back rather than
   treated as a new candidate.
2. The user then provided a genuinely different document: **"NAREN -
   EXECUTED LEASE...01162024 (1).pdf"**, `uploaded_file_id
   f26f2cb5-4764-496c-a68f-484fc7a41085`, same org
   (`1307dd95-e7c5-4e08-833e-749444e8f4c8`), `document_subtype:
   "base_lease"`. The first paste of this document was truncated
   mid-JSON (50,000-char message limit) before reaching
   `normalized_output`/`ui_review_payload`; the user re-pasted the
   complete `uploaded_files`, `pipeline_logs`, and `leases` export data,
   which is what this phase was run against.

## Candidate Validation

- **`uploaded_file_id`**: `f26f2cb5-4764-496c-a68f-484fc7a41085`
- **`org_id`**: `1307dd95-e7c5-4e08-833e-749444e8f4c8` (same org as the
  approved assignment document)
- **`document_subtype`**: `"base_lease"` — set consistently in the
  `uploaded_files` row itself, `normalized_output.document_subtype`, and
  `ui_review_payload.document_subtype`.
- **Content**: a full 17-page base lease between 224 Partners, LLC
  (landlord) and Mindful Tech Solutions, Inc. / Narendra Pydi (tenant),
  parsed via `azure_layout` (Azure Document Intelligence), normalized via
  the `hybrid` (rule + LLM) method — 19 fields rule-extracted, 10
  LLM-extracted, per `pipeline_logs`.
- **Status**: `review_required` / `review_status: pending` /
  `approved_at: null` — **this document has not been approved.** That's
  expected and fine for a policy-projection test; it also means the
  results below describe what the policy *would* compute, not an
  end-to-end approval outcome.
- **Real, unresolved conditions on this document** (useful contrast with
  the approved assignment document): `validationErrors` flag `start_date`
  and `end_date` as missing required fields; `enrichment_status: "failed"`
  with `enrichment_error: "Function failed due to not having enough
  compute resources (please check logs)"` (two Vertex AI 429
  resource-exhausted errors during the `enrich` pipeline stage, per
  `pipeline_logs`).
- **A `leases` row (`8f41718d-192d-4e2f-9e11-75c8bbfc06fd`) was also
  provided but does not match this document** — its `tenant_name`
  (`"NARENDRA PYDI"`, all-caps) and dates (`start_date: 2018-02-01`,
  `end_date: 2029-09-30`) match the *assignment* document's original-lease
  reference dates (Feb 2018 → Sept 2029), not this base lease (which has
  no `leases` row of its own and states a Feb 2024 commencement in its own
  text). This row was **not used** as test input; Task C ran directly off
  `uploaded_files.ui_review_payload`, matching the real
  `LeaseReview.jsx` code path (`leaseFull = { ...lease, uploaded_files:
  uploadedFile, uploaded_file: uploadedFile }`) and every prior phase's
  methodology.

## Method

Same methodology as every prior phase: a temporary Vitest file
(`src/lib/__tests__/tmp-phase45-baselease.test.js`, deleted after use)
built a `lease` fixture object mirroring `LeaseReview.jsx`'s real
`leaseFull` shape — a minimal `leases`-row stub (no matching `leases` row
exists for this unapproved document, which is itself realistic) merged
with the real `uploaded_files.ui_review_payload`/`normalized_output` data
under `uploaded_files`/`uploaded_file`, exactly as the app does. The
`standard_fields` array (35 entries) was transcribed verbatim from the
pasted `ui_review_payload.records[0].standard_fields`. The real
`normalizeLeaseReviewData()`, `resolveCurrentReviewProfile()`, and their
full dependency chain (`src/lib/leaseReviewFieldNormalizer.js`,
`src/lib/leaseReviewCurrentPolicy.js`, `src/lib/leaseReviewSchema.js`,
`src/lib/leaseFieldContract.js`) were exercised unmodified. `git status
--short` shows zero net `src/` diff after cleanup.

## Results

### 1. Profile resolution

**Correct.** `resolveCurrentReviewProfile()` → `"base_lease"`, driven by
`document_subtype` on the `uploaded_files` row (top-level lease stub had
no `document_subtype` of its own — matching this document's real
not-yet-linked-to-a-`leases`-row state — and resolution still worked via
the `ui_review_payload`/`normalized_output` fallback paths in
`collectProfileCandidates()`).

### 2. Base-lease blockers apply — confirmed, but a real key-mismatch bug was found

`currentReviewPolicy.applyBaseLeaseBlockers: true` (vs. `false` for the
assignment profile) — the base-lease policy branch does activate
correctly, unlike the assignment-only advisory treatment.

However, projecting real data through it surfaced a genuine,
**pre-existing** bug in `normalizeApprovalBlockers()` (`src/lib/
leaseReviewFieldNormalizer.js:794-806`), invisible until tested against
a base-lease document because the assignment profile's required-key list
happens not to trigger it:

- The base-lease profile's `requiredFieldKeys` come from
  `currentReviewPolicy`'s `legacyRequiredFieldKeys` parameter, which is
  `REQUIRED_FIELD_KEYS` from `src/lib/leaseReviewSchema.js` — an **older**
  key-naming scheme (`premises_address`, `premises_use`, `lease_term`).
- `standardFields` (and the `byKey` map built from it) is keyed by
  `LEASE_FIELD_CONTRACT`'s **canonical keys**
  (`src/lib/leaseFieldContract.js`) — a **different, newer** naming scheme
  for the same concepts (`property_address`, `permitted_use`,
  `lease_term_months`).
- The "supplementary pass" that adds `policyRequiredKeys` not already
  covered by the `LEASE_FIELD_CONTRACT` loop
  (`leaseReviewFieldNormalizer.js:794-806`) does `byKey.get(key)` using the
  **legacy** key name directly — it never aliases `premises_address` →
  `property_address` the way `readFieldValue()`'s alias table
  (`leaseReviewSchema.js:210-211`,
  `premises_address: ["premises_address", "property_address",
  "premises_location"]`) does. Since no row in `standardFields` is ever
  keyed `"premises_address"`, `byKey.get("premises_address")` is always
  `undefined`, so `premises_address` is unconditionally added to
  `missingFields` — **even when `property_address` has a real,
  evidence-verified value.**

This is demonstrated concretely by this document's own data:
`property_address` = `"224 S Peters Road Knoxville, TN 37923"`,
`status: "needs_review"` (not `missing`), `evidenceVerified: true`,
`extractionMode: "explicit"` — a populated, source-backed field — and yet
`approvalBlockers.missingFields` still lists `premises_address` as
missing. The same structural gap applies to `premises_use` (→
`permitted_use`) and `lease_term` (→ `lease_term_months`); in this
particular document those two would be legitimate blockers anyway
(`permitted_use` was rejected as a markup artifact, `lease_term_months`
is genuinely null), so `property_address`/`premises_address` is the clean,
unambiguous proof case.

**This bug was not fixed in this phase** (Phase 45 is a
testing/verification phase; no source changes were planned or made). It's
flagged here as the phase's central finding and a strong candidate for a
narrowly-scoped follow-up fix (alias `policyRequiredKeys` through the same
alias table `readFieldValue` already uses, or normalize both key schemes
to one canonical set).

Real, correctly-computed blockers on this document (not affected by the
naming bug): `landlord_name` (rejected as markup artifact — genuinely
missing), `lease_date` (genuinely null), `commencement_date`/
`expiration_date` (genuinely null — this document's real commencement date,
"February 1, 2024", never made it into a normalized date field).

### 3. Assignment-only policy correctly does not apply

No assignment-specific advisory items appeared (`original_lease_missing`,
"Tenant Name should be reviewed in assignment context...", "Landlord
Consent should be reviewed in assignment context..." — all zero for this
document, `warnings: []`). `assignor_name`/`assignee_name`/
`assignment_effective_date`/`assignment_consideration` are all genuinely
null in the source data and did not distort the blocker set.

### 4. Economics/CAM/budget relevance — correctly differentiated from the assignment profile

| | Assignment doc (Phase 44A-Fix) | Base lease doc (Phase 45) |
| --- | --- | --- |
| `budgetReadiness` | `ready` | **`blocked`** |
| `camReadiness` | `ready` | **`needs_review`** |
| `budgetBlockers` | `[]` | 5 keys (`start_date`, `end_date`, `commencement_date`, `expiration_date`, `billing_frequency`) |
| `camBlockers` | `[]` | 15 keys (`start_date`, `end_date`, `commencement_date`, `expiration_date`, `base_year`, `expense_stop`, `cam_amount`, `cam_cap_type`, `cam_cap_pct`, `admin_fee_pct`, `management_fee_basis`, `gross_up_enabled`, `gross_up_threshold`, `responsibility_taxes`, `building_rsf`) |

This is the intended, correct contrast: the assignment profile treats
missing CAM/budget inputs as advisory-only (`original_lease_missing`);
the base-lease profile correctly treats them as real
budget/CAM blockers since there's no "original lease" to defer to. All 15
CAM blockers and 5 budget blockers reflect real gaps in this document's
extraction (this document genuinely has no CAM structure — its own
`ui_review_payload.warnings` independently confirms: `LLM group
"cam_structure" parsed successfully but all field values are null.`).

### 5. Extraction Mode distribution

16 of 88 standard fields are `explicit`/evidence-verified (rule- or
LLM-sourced with real page/text evidence); the remaining 72 are `unknown`
(missing, or present but without the evidence needed to classify a mode —
e.g. `annual_rent`/`rent_per_sf`/`default_cure_period`, which are
*derived/LLM* values without their own dedicated evidence entries in this
payload). `debugCounts`: `standard_fields_total: 88`,
`standard_fields_populated: 19`, `standard_fields_source_backed: 16`,
`standard_fields_needs_review: 19`, `standard_fields_missing: 69`. The
resolver correctly distinguishes evidence-backed values from populated
values, matching its documented behavior — no regression or surprise here.

### 6. Evidence integrity rules hold on real rejected data

`landlord_name` and `permitted_use` both carry real
`validation_errors: ["Rejected: extracted value contained HTML/markup
fragments"]` in the source payload (from `<td>` table-cell artifacts
literally leaking into the extracted value: `"2. Landlord:</td>"`,
`"10. Permitted Use:</td>"`) and both surfaced as `status: "missing"` /
`"needs_review"` — never as clean auto-populated values. This confirms
the markup-artifact rejection path holds on a second, independent
document with a different failure shape than anything in the Phase 44A-Fix
tests.

### 7. Clause Records — no noise, because there's nothing to union

`clauseRecordsCount: 0`. This document's payload has no `lease_clauses`
array at all (unlike the assignment document, which had a rich clause
array); `computeFallbackClauseRows()` ran against the `standard_fields`
union path and correctly produced zero rows rather than fabricating
clause rows from thin air or crashing. No dedup/noise behavior to exercise
here — a different but equally valid "doesn't break" result.

### 8. Enrichment state

This document's `enrichment_status: "failed"` (Vertex 429s) is a
genuinely different condition than anything seen in the approved
assignment document's history. `normalizeLeaseReviewData()` ran cleanly
against it with no special-casing needed or errors thrown — the
enrichment failure only affects which fields have LLM-sourced values (10
groups attempted, 5 succeeded per `pipeline_logs`), not the normalizer's
ability to process whatever data did land. Enrichment-status banner
rendering itself (`LeaseReview.jsx` reads
`uploadedFile.ui_review_payload.enrichment_status`) is presentation-layer
and was confirmed only by reading the component code, not a live browser
session (consistent with "no deploy") — the underlying data path is
correct; the visual banner itself was not independently re-verified in a
running app this phase.

### Presentation-only items (Type column hidden, Action dropdown present, debug/admin gating)

Not independently re-verified via a live UI session this phase (no deploy,
no dev server run for this verification). These are governed by the same
profile-aware code already exercised and unchanged across every prior
phase; nothing in this phase's findings implicates them. Flagged plainly
as "not re-tested" rather than claimed as confirmed.

## Comparison Table: Assignment Document vs. Base Lease Document

| | Assignment (`fc8181e6-...`, approved) | Base lease (`f26f2cb5-...`, unapproved) |
| --- | --- | --- |
| `document_subtype` | `assignment` | `base_lease` |
| Profile resolved | `assignment` | `base_lease` |
| `applyBaseLeaseBlockers` | `false` | `true` |
| `approvalBlockers.missingFields` | `["assignor_name"]` (1) | 7 keys — 6 real, 1 (`premises_address`) a false positive from the key-mismatch bug above |
| `advisoryGaps`/`warnings` | 3 (original lease missing, tenant name, landlord consent — all advisory) | 0 |
| `budgetReadiness` | `ready` | `blocked` |
| `camReadiness` | `ready` | `needs_review` |
| Clause Records count | 19 (16 pending, 3 needs_review) | 0 (no `lease_clauses` array in source) |
| Extraction mode distribution | 13 `explicit` / 75 `unknown` (88 fields) | 16 `explicit` / 72 `unknown` (88 fields) |
| Enrichment state | not re-verified this phase (assumed complete, per prior phases) | `failed` (Vertex 429 ×2) |
| Approval status | approved | `review_required`, unapproved |

## Recommendation

**No Gate** — unchanged. This phase found no correctness regression in
approval-gating behavior for either document (the approved assignment
document's blocker set is untouched; this phase made no source changes).

**One real finding for a follow-up phase**: the `premises_address`/
`premises_use`/`lease_term` vs. `property_address`/`permitted_use`/
`lease_term_months` key-naming mismatch in `normalizeApprovalBlockers()`'s
supplementary policy-required-keys pass. This is a genuine generalization
gap that the single-assignment-document test surface could never have
caught (the assignment profile's required-key list doesn't include these
three legacy names), demonstrating exactly why Track 1's "test a second
document type" step mattered. Recommend a narrowly-scoped follow-up phase
to alias these three legacy keys through the same alias table
`readFieldValue()` already uses, verified against both the assignment
document (must remain unchanged) and this base-lease document
(`premises_address` should stop appearing in `missingFields` once
`property_address` is populated).

## Next Step

Continue Track 1: build a small multi-document QA set (this phase adds
one real base-lease data point); scope and implement the
`premises_address`/`premises_use`/`lease_term` alias fix as its own
focused phase once approved; consider approving this base-lease document
through the normal review flow (out of scope for this phase — no writes
were made) if the org wants a second fully end-to-end verified document.
