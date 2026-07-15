# Document Intelligence v3 — Phase 46: Base-Lease Required-Field Alias Fix

## Goal

Fix the base-lease required-field alias gap found in Phase 45: populated,
evidence-backed fields could still show up as missing approval blockers
under a different (legacy) key name.

## Root Cause

`REQUIRED_FIELD_KEYS` in `src/lib/leaseReviewSchema.js` uses legacy field
names for the base-lease profile's required fields — `premises_address`,
`premises_use`, `lease_term`. `standardFields` (and every map built from
it) is keyed by `LEASE_FIELD_CONTRACT`'s newer canonical names
(`src/lib/leaseFieldContract.js`) — `property_address`, `permitted_use`,
`lease_term_months` — for the same underlying concepts.

Two functions in `src/lib/leaseReviewFieldNormalizer.js` checked required
keys with a **direct** lookup against `standardFields`, with no alias
resolution:

1. `normalizeApprovalBlockers()`'s supplementary `policyRequiredKeys` pass
   (was lines 811-822): `byKey.get(key)` where `key` is the legacy name —
   always `undefined` for `premises_address`/`premises_use`/`lease_term`,
   since no row is ever keyed that way.
2. `buildReadinessSummary()` (was line 907):
   `requiredKeys.filter((key) => !hasRowValue(byKey.get(key)))` — the
   identical bug, independently duplicated, producing the same false
   positive in `readinessSummary.missingRequiredFields`.

Meanwhile `readFieldValue()`/`readFieldEvidence()` (`leaseReviewSchema.js`)
already resolve aliases correctly via `resolveLeaseField()` →
`getFieldAliases()` (`src/lib/leaseFieldResolver.js`) — which is why the
**value itself** always displayed correctly in the field table
(`property_address` showed up fine); only the two blocker-computation
functions above, which read `standardFields` directly instead of calling
`readFieldValue`, never got the same treatment.

Proven concretely with the real Phase 45 base-lease document
(`f26f2cb5-4764-496c-a68f-484fc7a41085`): `property_address` =
`"224 S Peters Road Knoxville, TN 37923"`, `evidenceVerified: true`, yet
`approvalBlockers.missingFields` still listed `premises_address`.

## Fix

A single shared helper, added next to the existing `hasRowValue()` in
`src/lib/leaseReviewFieldNormalizer.js`:

```js
import { getFieldAliases } from "@/lib/leaseFieldResolver";

function requiredFieldHasValue(byKey, key) {
  return getFieldAliases(key).some((aliasKey) => hasRowValue(byKey.get(aliasKey)));
}
```

Used in the exact two spots that had the bug — no other logic touched:

1. `normalizeApprovalBlockers()`'s supplementary pass now calls
   `requiredFieldHasValue(byKey, key)` instead of the old inline
   `isMeaningfulValue(policyRow?.value) || policyRow?.invalidValueRejected === true`
   check against a direct `byKey.get(key)`.
2. `buildReadinessSummary()`'s `missingRequired` now filters with
   `!requiredFieldHasValue(byKey, key)` instead of `!hasRowValue(byKey.get(key))`.

This reuses `getFieldAliases()` (`src/lib/leaseFieldResolver.js:6-92`) —
the **same** alias table `readFieldValue`/`readFieldEvidence` already use
— rather than inventing a second, competing alias system. It also reuses
the existing `hasRowValue()` gate verbatim, so the same
"weak/rejected/valueless evidence does not satisfy" and the Phase 39
`invalidValueRejected` historical carve-out apply identically through the
alias path as they always did through the direct-key path.

**Not touched, deliberately, to keep blast radius minimal:**
- The main `LEASE_FIELD_CONTRACT` loop in `normalizeApprovalBlockers`
  (checks contract rows against their own matching `canonicalKey` — no
  alias ambiguity there).
- `tabSummaries[].missingRequired` (a per-tab cosmetic count that already
  under-counted in the same historical way; not a blocker, not required to
  fix the reported bug).

**Disclosed side effect of reusing the full shared alias table** (not
narrowly hand-picking only the 3 named pairs, per the plan's explicit
instruction to reuse the existing table rather than build a second one):
`getFieldAliases("commencement_date")` also includes `"start_date"`, and
`getFieldAliases("expiration_date")` also includes `"end_date"` — the same
alias relationship already used elsewhere in the codebase
(`FIELD_COLUMN_ALIASES` in `leaseReviewSchema.js`). This can only ever
turn a false-positive "missing" into a correctly-recognized present value
under a different name; it can never mark a genuinely-missing field as
present. In the real Phase 45 base-lease document both `start_date` and
`end_date` are also null, so this had no effect on that document's result,
but it's disclosed here as an honest, intentional consequence of the fix
rather than a silent surprise.

## Verification

### Task A — Reproduced

A temporary Vitest fixture (deleted after use), built from the real Phase
45 `standard_fields` data, confirmed the bug pre-fix:
`missingFields` included `premises_address` despite `property_address`
being populated and `evidenceVerified: true`.

### Task C — Assignment document unaffected

Re-ran the real approved assignment document's field/evidence shape
(`fc8181e6-766d-49c7-b81b-b5d961160207` / `7b21f353-579d-48e8-b3dd-8e8c49743fe2`)
through `normalizeLeaseReviewData()`:

- `currentReviewPolicy.profile`: `"assignment"` — unchanged.
- `approvalBlockers.missingFields`: `["assignor_name"]` — unchanged.
- `approvalBlockers.budgetBlockers` / `camBlockers`: `[]` / `[]` —
  unchanged.
- Advisory gaps present: `original_lease_missing`,
  `tenant_name_assignment_advisory`, `landlord_consent_assignment_advisory`
  — unchanged.

None of the assignment profile's required keys (`assignee_name`,
`assignment_effective_date`, `landlord_name`, `assignor_name`,
`original_lease_date`, `original_lease_reference`, `assumption_scope`,
`assignment_provisions`, `all_other_terms_remain_same`,
`amended_base_rent_for_additional_year`, `tenant_signature_date`,
`landlord_signature_date`, `tenant_signatory_name`,
`landlord_signatory_name`) have aliases that resolve to a *different*
`standardFields` canonical key than before (confirmed by reading
`FIELD_ALIASES`), so `requiredFieldHasValue` behaves identically to the
old direct check for every one of them.

### Task D — Base lease document, corrected expectations

Re-ran the real Phase 45 base-lease document
(`f26f2cb5-4764-496c-a68f-484fc7a41085`) through `normalizeLeaseReviewData()`.
**Only one of the three named keys actually clears for this document** —
the other two remain genuine blockers because their aliased fields are
themselves empty/rejected in this document's real extraction:

| Legacy required key | Alias checked | Alias state in this document | Result |
| --- | --- | --- | --- |
| `premises_address` | `property_address` | Populated, `evidenceVerified: true` | **Cleared** |
| `premises_use` | `permitted_use` | Rejected as markup artifact (`value: null`) | Still blocks |
| `lease_term` | `lease_term_months` | Genuinely null | Still blocks |

`approvalBlockers.missingFields` before: 7 keys (`lease_date`,
`landlord_name`, `commencement_date`, `expiration_date`,
`premises_address`, `premises_use`, `lease_term`). After: **6 keys** —
only `premises_address` removed. `budgetBlockers`/`camBlockers` unchanged
(they reference different canonical keys entirely — `start_date`,
`end_date`, `billing_frequency`, CAM structure fields — none affected by
this fix). `readinessSummary.missingRequiredFields` shows the same
before/after change.

### Task E — Tests added

`src/lib/__tests__/leaseReviewFieldNormalizer.test.js`, two new
`describe` blocks, 9 new tests total (all passing; full file: 52/52):

**`"Phase 46: base-lease required-field alias resolution"`** (8 tests):
1. `premises_address` resolves via populated + evidence-verified
   `property_address`.
2. `premises_use` resolves via populated + evidence-verified
   `permitted_use`.
3. `lease_term` resolves via populated `lease_term_months`.
4. Missing canonical field (`property_address` absent) → `premises_address`
   still blocks.
5. Rejected/markup-artifact alias row (`permitted_use` value `null` with
   `validation_errors`) does not satisfy `premises_use`.
6. `needs_review` alias row with no meaningful value and no
   `invalidValueRejected` flag does not satisfy `premises_address`.
7. No matching row at all still blocks `premises_address`.
8. The Phase 39 `invalidValueRejected` carve-out (a real `"</td>"`
   markup-artifact value on `property_address`) still applies through the
   alias path exactly as it did for direct-key lookups — proven against
   `normalizeStandardFields` directly (`invalidValueRejected: true`,
   `value: null`) and then against the full blocker computation
   (`premises_address` not added as a new blocker).
9. Real Phase 45 base-lease fixture: `missingFields` drops from 7 to 6,
   exactly as described in Task D above.

**`"Phase 46: assignment document behavior is unaffected by the alias
fix"`** (1 test): the real approved-document field/evidence shape
produces exactly `missingFields: ["assignor_name"]`, empty budget/CAM
blockers, and the three expected advisory gaps.

## Files Changed

- `src/lib/leaseReviewFieldNormalizer.js` — the fix (one import, one
  helper function, two call-site changes).
- `src/lib/__tests__/leaseReviewFieldNormalizer.test.js` — 9 new tests
  across 2 new `describe` blocks.
- `docs/document-intelligence-v3-phase46-base-lease-alias-fix.md` (this
  file).
- `docs/document-intelligence-v3-batch-audit-qa.md` / `.json` — Phase 46
  sections appended.

## Alias Bug Fixed

**Yes.**

## Assignment Regression

**None.** Blocker set, advisory gaps, and budget/CAM readiness all
unchanged for the approved assignment document.

## Base Lease Regression

**None — requiredness preserved, only the false positive removed.**
`premises_use` and `lease_term` still correctly block on this document
(their aliased fields are genuinely empty/rejected); every other
genuinely-missing required field still blocks.

## Remaining Blockers (base-lease document, post-fix)

`lease_date`, `landlord_name`, `commencement_date`, `expiration_date`,
`premises_use`, `lease_term` — all genuine (no populated, evidence-backed
alias exists for any of them in this document's real extraction).

## Recommendation

**No Gate.** This phase fixed a narrow, well-isolated bug with no change
to approval-gating semantics beyond correcting the false positive — v3
remains advisory, base-lease requiredness remains strict, assignment
behavior is provably unchanged.

## Recommended Next Step

Continue Track 1's multi-document QA set. Consider whether the
`tabSummaries[].missingRequired` per-tab cosmetic under-count (noted above,
not touched this phase) is worth a small follow-up for UI-count accuracy —
low priority, no blocker/gating impact. Consider approving the base-lease
document (`f26f2cb5-...`) through the normal review flow now that its
`premises_address` false positive is resolved, if a second fully
end-to-end verified (approved) document is wanted.
