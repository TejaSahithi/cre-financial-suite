# Document Intelligence v3 — Phase 44A Lease Review Hardening

Generated: 2026-07-15

## 1. Executive Summary

Phase 44A resolves the two open Phase 42 partials for the approved
assignment document. No source code was changed — both tasks were
root-cause/audit work only, per the phase's constraints.

- **Partial 1 (`landlord_consent`): root-caused, not resolved.** The cause
  is a regex word-boundary bug in `booleanSourceSupportsValue()`
  (`src/lib/leaseReviewSchema.js`) that matches the bare word "consent" but
  not its conjugated form "consents" — which is exactly what the source
  text uses. Classified as **validation rule too strict**. A fix is
  described but not implemented this phase.
- **Partial 2 (Clause Records): audited, not clean.** All 35 rows were
  classified individually (not a spot check). The result is materially
  worse than the earlier 5-row sample suggested: **12 of 35 rows duplicate
  a standard field's evidence verbatim, 19 of 35 are noisy/low-value
  (including 16 that are near-exact internal duplicates of another Clause
  Records row), 3 present previously-rejected evidence as if it were a
  clean legal summary, and only 1 of 35 provides genuinely distinct legal
  content.** This is a real, well-characterized finding, not an open
  question anymore — but it is a finding that something should be fixed,
  not evidence that nothing needs fixing.

Neither finding changes approval-gating behavior or staging-review
readiness for this document. Recommendation remains: **No Gate**.

## 2. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

No deploy, remote read, production write, secrets/service-key use,
`SUPABASE_ACCESS_TOKEN`, Azure/Vertex/Gemini call, parse/extraction rerun,
or approval-behavior change occurred. All data came from a read-only local
Postgres dump (`127.0.0.1:54322`) and the real, unmodified
`normalizeLeaseReviewData()`/`normalizeClauseRecords()` functions, run via
a temporary Vitest file that was deleted immediately after use —
`git status --short` confirmed zero `src/` diff both mid-phase and at the
end.

## 3. `landlord_consent` Evidence Root Cause

**Data:** `value: true`, `source_page: 1`, `source_text: "Landlord hereby
consents to the assignment and assumption of the Lease as set forth
herein, subject to the terms and conditions of this Agreement."`
(consistent across 5 independent payload paths in the raw
`ui_review_payload`).

**Resolution chain traced:**

1. `resolveSourceTextQuality()` (`leaseReviewSchema.js:1125`) calls
   `sourceTextSupportsValue()` (`:709`) to check whether the source text
   actually supports the extracted value.
2. For a **boolean** candidate value, `sourceTextSupportsValue` delegates
   to `booleanSourceSupportsValue()` (`:704-707`):
   ```js
   function booleanSourceSupportsValue(sourceText) {
     const source = normalizeEvidenceComparable(sourceText);
     return /\b(shall|must|required|insurance|additional insured|waiver|consent|option|renewal|terminate|not required|no right|none)\b/.test(source);
   }
   ```
3. The regex requires the exact word **"consent"** with a trailing word
   boundary (`\bconsent\b`). The source text contains **"consents"**
   (present tense, third person) — `\b` fails to match between "consent"
   and the following "s" because both are word characters, so
   `/\bconsent\b/` does not match "consents". No other keyword in the list
   appears in the sentence.
4. `booleanSourceSupportsValue` returns `false` → `sourceTextSupportsValue`
   returns `false` → `resolveSourceTextQuality` hits
   `if (hasValue && !supportsValue) return SOURCE_TEXT_QUALITIES.INCONSISTENT`.
5. `hasValidSourceEvidence()` only accepts `[EXACT, PARTIAL, DERIVED]` —
   `INCONSISTENT` is not in that list → `evidenceVerified: false`.

**Confirmed this is the complete explanation, not a partial one:** page
(`1`) is present, and `hasNaturalSourceBoundary()` would pass (the text
starts with "Landlord", which is on the allowed-start-word list at
`leaseReviewSchema.js:657`). Absent the boolean-matching failure, this
would resolve to `EXACT` quality and `evidenceVerified: true`. There is no
second contributing factor.

## 4. `landlord_consent` Recommendation

**Root cause classification: validation rule too strict.**

Do not force `landlord_consent` to `explicit`/`evidenceVerified: true`
without fixing the actual rule — that would be fabricating a pass, not
fixing the bug. The evidence genuinely supports the value; the rule's
wording is what's wrong.

**Recommended fix (not implemented this phase, requires separate
approval):** broaden `booleanSourceSupportsValue`'s keyword matching to
cover common verb inflections, e.g. `consent\w*` instead of `\bconsent\b`,
and apply the same treatment to the other verb-like keywords in that list
(`terminat\w*`, `requir\w*`, `waiv\w*`, `renew\w*`) which are equally
vulnerable to the same word-boundary gap for their own conjugated forms.
This is a narrow, low-risk, single-function change with an obvious
regression test (the exact sentence above, plus a few conjugated
variants), but it is a source-code change and is explicitly out of scope
for Phase 44A.

## 5. Clause Records Audit Summary

| Classification | Count | % of 35 |
| --- | ---: | ---: |
| Valid legal summary (genuinely distinct content) | 1 | 2.9% |
| Duplicate standard field (verbatim match to a standard field's evidence) | 12 | 34.3% |
| Noisy / low value | 19 | 54.3% |
| Needs review (surfaces previously-rejected evidence as a clean summary) | 3 | 8.6% |
| **Total** | **35** | **100%** |

Of the 19 "noisy / low value" rows, **16 are near-exact internal
duplicates** of another row already counted above (same clause text,
missing `source_page`) — i.e. the same clause is shown to the reviewer
twice, back to back in the same tab, with the second copy carrying strictly
less information than the first. The remaining 3 noisy rows are truncated
mid-sentence fragments (see §7).

## 6. Clause Records Row-by-Row Classification

| # | Field/Label | Content (truncated) | Page | Classification | Note |
| - | --- | --- | --- | --- | --- |
| 0 | Status | "THIS ASSIGNMENT...Effective Date" | 1 | Duplicate standard field | Matches `assignment_effective_date` evidence verbatim; also identical to row 16 and row 19/32 |
| 1 | Tenant Name | "DDDD -- - DU-40009/3L ASSIGNMENT...(truncated)" | 1 | Needs review | Duplicates `tenant_name`'s known weak/unverified evidence (Phase 39/42) — shown here with no caveat |
| 2 | Assignee Name | "NARENDRA PYDI, a resident of..." | 1 | Duplicate standard field | Matches `assignee_name` verbatim |
| 3 | Assignor Name | "Assignor and Assignee desire to enter into this Agreement to, among" | 1 | Noisy / low value | Truncated mid-sentence fragment (cuts off after "among"); also duplicates `assignor_name`'s evidence text |
| 4 | Square Footage | "approximately 4,200 rentable square feet" | 1 | Duplicate standard field | Matches `square_footage` verbatim |
| 5 | Assumption Scope | "Assignee hereby assumes the obligations" | 1 | Noisy / low value | Truncated fragment; also duplicates `assumption_scope`'s evidence text |
| 6 | Landlord Consent | "Landlord hereby consents to..." | 1 | Duplicate standard field | Matches `landlord_consent` verbatim (same text root-caused in §3) |
| 7 | Property Address | "for the lease of approximately 4,200 rentable square feet..." | null | Duplicate standard field | Matches `property_address` verbatim |
| 8 | Security Deposit | "Assignee shall pay to Landlord...$8,575.00" | 2 | Duplicate standard field | Matches `security_deposit` verbatim |
| 9 | Lease Term Months | "Landlord and Assignor...Lease dated February 1, 2018...extend the initial Term...expire September 30, 2029" | 1 | **Valid legal summary** | Only row providing distinct, useful legal context (term-extension mechanics) not captured as-is by any currently-accepted standard field |
| 10 | Assignment Provisions | "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE" | 1 | Duplicate standard field | Matches `assignment_provisions` verbatim |
| 11 | Tenant Signatory Name | "By: Doug Fleming" | null | Duplicate standard field | Matches `tenant_signatory_name` verbatim |
| 12 | Tenant Signature Date | "Tenant, entered into that certain Lease dated February 1, 2018" | null | Needs review | This is the exact sentence Phase 39 rejected as signature-date evidence (original-lease-reference text) — shown here as an unflagged clause |
| 13 | Assignee Notice Address | "7. Assignee Notice Address...1240 BENTLEY PARK LN..." | 2 | Duplicate standard field | Matches `assignee_notice_address` verbatim |
| 14 | Landlord Signature Date | "Landlord and Assignor, as Tenant, entered into that certain Lease dated February 1, 2018" | 1 | Needs review | Same Phase 39 rejected-evidence issue as row 12, landlord side |
| 15 | Assignment Consideration | "consideration of Ten and No/100 Dollars ($10.00" | 1 | Noisy / low value | Truncated fragment (missing closing paren/period); duplicates `assignment_consideration`'s evidence text |
| 16 | Assignment Effective Date | "THIS ASSIGNMENT...Effective Date" | 1 | Duplicate standard field | Identical text to row 0; matches `assignment_effective_date` verbatim |
| 17 | All Other Terms Remain Same | "All other terms of the Lease shall remain the same." | 1 | Duplicate standard field | Matches `all_other_terms_remain_same` verbatim |
| 18 | Amended Base Rent For Additional Year | "Base Rent for the additional one year shall be $118,849.50." | 1 | Duplicate standard field | Matches `amended_base_rent_for_additional_year` verbatim |
| 19-34 | *(16 rows)* | Same text as rows 0, 2, 4, 6, 7, 8, 10, 11, 13, 16, 17, 18 respectively (and row 1's untruncated variant, row 3/5/9/14/15's text) | null (all 16) | Noisy / low value | Near-exact duplicate of an earlier row in this same list, differing only by a missing `source_page` (see §7 for the mechanism) |

## 7. Duplicates / Noise Found

**Cross-reference against the requested categories** (assignment parties,
original lease date, assignment effective date, term extension, rent
amount, security deposit, landlord consent, all-other-terms language,
signatures):

| Category | Duplicated in Clause Records? | Row(s) |
| --- | --- | --- |
| Assignment parties (assignor/assignee/tenant identity) | Yes | 1, 2, 3, 20-22 |
| Original lease date | Indirectly — embedded in row 9's term-extension sentence, and separately reused (mis-)as rejected signature-date evidence in rows 12/14 | 9, 12, 14 |
| Assignment effective date | Yes, twice over (rows 0 and 16 are the same sentence under two different labels) | 0, 16, 19, 32 |
| Term extension | Row 9 is the only place this appears; not a duplicate of any *accepted* standard field | 9 |
| Rent amount | Yes | 18, 34 |
| Security deposit | Yes | 8, 26 |
| Landlord consent | Yes (the field root-caused in §3) | 6, 25 |
| All-other-terms language | Yes | 17, 33 |
| Signatures (signatory name / signature date) | Yes — signatory name duplicated; signature dates reproduce Phase 39's already-rejected evidence text without carrying the rejection forward | 11, 12, 14, 29 |

**Internal duplication mechanism (traced, not fixed):** `computeFallbackClauseRows()`
(`leaseReviewFieldNormalizer.js:439+`) unions **5 separate `lease_fields`-shaped
payload maps** (`workflowOutput.lease_fields`, `recordOutput.lease_fields`,
`lease.extraction_data.fields`, `ufWorkflowOutput.lease_fields`,
`ufRecordOutput.lease_fields`) into `fieldMapRows` (`:469-489`). Each map's
entry gets `item_id: field-map-${mapIdx}-${key}` — the map index is baked
into the id, so the *same* field key present in two different maps (with
the same or near-same text, but different `source_page` completeness)
produces two distinct, non-deduped rows. This matches the observed pattern
exactly: 16 fields each appear twice, always differing only by a missing
page number on the second copy. This is a plausible, well-grounded
explanation given the code's structure, but was not separately verified by
tracing which two specific maps disagree for this document — that level of
detail was not needed to complete the audit or classify the rows, and
doing so would begin to shade into a code-level investigation beyond this
phase's read-only audit scope.

## 8. Whether The Two Phase 42 Partials Are Resolved

- **Partial 1 (`landlord_consent`): root-caused, not resolved.** The exact
  cause is identified and explained (§3-4). No code was changed. Fixing it
  requires separate approval.
- **Partial 2 (Clause Records): audited, not resolved as "clean."** The
  audit itself is complete — all 35 rows classified, not a sample. The
  audit's *result* is that Clause Records substantially duplicate standard
  fields and each other on this document (§5-7). The uncertainty from
  Phase 42 (spot-check only) is resolved; the underlying product finding is
  not — it is now a concrete, well-scoped item for Track 1 follow-up.

## 9. Staging Review Impact

**None.** Both findings are display/content-quality issues, not
correctness or safety issues — no invalid value is shown as fact, no
approval-relevant computation is affected. Controlled staging/business
review for the approved assignment document remains appropriate.

## 10. Approval Gating Impact

**None.** `approvalBlockers.missingFields` is untouched (still
`["assignor_name"]` only, confirmed unchanged by this phase's data pull).
Neither finding changes any gating-relevant computation.

## 11. Recommendation

**No Gate.** Both Phase 42 partials have been fully investigated. Neither
finding blocks controlled staging review of the approved document. Both
are legitimate, scoped candidates for Track 1 follow-up work, pending
separate approval to implement any code change.

## 12. Recommended Next Step

Two small, independent, low-risk follow-up items are now ready for
approval as isolated fixes, if the business wants to act on them before
the rest of Track 1 (second document type, multi-document QA set):

1. **`booleanSourceSupportsValue` regex fix** (§4) — broaden keyword
   matching to cover common verb conjugations. Narrow, single-function,
   easily regression-tested.
2. **Clause Records dedup fix** — collapse near-exact duplicate rows
   produced by `computeFallbackClauseRows`'s multi-map union (§7),
   likely by deduping on normalized clause text rather than (or in
   addition to) `item_id`, and preferring the copy with a non-null
   `source_page` when a duplicate pair is found.

Neither is authorized by this report — both require explicit, separate
approval before any source code change, consistent with every prior
phase's constraints.
