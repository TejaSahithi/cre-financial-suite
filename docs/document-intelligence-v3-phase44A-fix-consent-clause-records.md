# Document Intelligence v3 — Phase 44A-Fix: landlord_consent + Clause Records Fixes

Generated: 2026-07-15

## 1. Executive Summary

Phase 44A-Fix implements the two fixes identified as root-caused/audited in
Phase 44A, for the approved assignment document:

1. **`landlord_consent` regex fix — done, and a second, deeper bug found and
   fixed too.** The planned `booleanSourceSupportsValue()` word-stem fix was
   necessary but not sufficient: while implementing and testing it, a
   second, pre-existing bug was found in `readFieldEvidence()` — it never
   carried a properly-typed `.value` in its returned evidence object, so
   `sourceTextSupportsValue()`'s `typeof candidate === "boolean"` check
   silently failed for every boolean field going through the real
   production path (the evidence object only had a *stringified*
   `rawValue`, e.g. `"true"` instead of `true`). Both bugs are now fixed.
   On the approved document, `landlord_consent` is now `evidenceVerified:
   true`, `status: "auto_populated"`, `extractionMode: "explicit"`.
2. **Clause Records dedup + rejected-evidence handling — done.** Clause
   Records count dropped from 35 to **19** (exactly the 16 internal
   near-exact duplicates identified in the Phase 44A audit, now removed).
   3 rows are now flagged `needs_review` instead of appearing as clean
   `pending` summaries — the two signature-date rows sourced from the
   original lease reference (as expected), plus one additional row (Lease
   Term Months) that legitimately shares the same textual pattern and is
   correctly caught by the same guard.

No approval-gating behavior changed: `approvalBlockers.missingFields`
remains exactly `["assignor_name"]`. `assignor_name` remains the only hard
blocker. Recommendation remains: **No Gate**.

## 2. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

No deploy, remote read, production write, secrets/service-key use,
`SUPABASE_ACCESS_TOKEN`, Azure/Vertex/Gemini call, parse/extraction rerun,
or approval-behavior change occurred. All verification used a read-only
local Postgres dump and the real `normalizeLeaseReviewData()` function, run
via temporary Vitest files deleted immediately after use — `git status
--short` confirmed clean of leftover temp files throughout.

## 3. Task A — `landlord_consent` Fix

### 3a. The planned fix

`booleanSourceSupportsValue()` (`src/lib/leaseReviewSchema.js`) widened
from exact-word matching to word-stem matching for the verb-like keywords:

```js
// before
/\b(shall|must|required|insurance|additional insured|waiver|consent|option|renewal|terminate|not required|no right|none)\b/

// after
/\b(shall|must|requir\w*|insurance|additional insured|waiv\w*|consent\w*|option|renew\w*|terminat\w*|not required|no right|none)\b/
```

This alone was confirmed correct via 6 direct unit tests against
`resolveSourceTextQuality`/`hasValidSourceEvidence` with hand-built evidence
objects — including the exact real sentence, which resolves to `EXACT`
quality when the evidence object includes a properly-typed `value: true`.

### 3b. The second bug found while testing the real fixture

Testing the fix through the actual production path
(`normalizeStandardFields` → `readFieldEvidence` → `hasValidSourceEvidence`,
not a hand-built evidence object) revealed the fix was **unreachable**
there. Traced precisely:

1. `readFieldEvidence()`'s returned evidence object never included a
   `.value` property — only `.rawValue`.
2. `resolveLeaseField()`'s `buildResolverOutput()`
   (`src/lib/leaseFieldResolver.js`) sets `rawValue` via a fallback chain
   that ends in `String(output.value)` whenever there's no dedicated
   raw-text source on the entry. For `landlord_consent`'s real payload
   shape (a rich object with `value: true` but no top-level `raw_value`/
   `source_text`, only nested `evidence.source_text`), this produced
   `rawValue: "true"` — the stringified boolean, not the boolean.
3. `sourceTextSupportsValue()` computes `candidate = value ?? rawValue`.
   With `evidence.value` missing and `evidence.rawValue` = `"true"` (a
   string), `candidate` was the **string** `"true"`, so
   `typeof candidate === "boolean"` was false and
   `booleanSourceSupportsValue()` — the function just fixed — was **never
   called**. Execution fell through to generic substring matching, which
   checks whether the literal text `"true"` appears in the source sentence
   — it never does for real lease language — producing
   `SOURCE_TEXT_QUALITIES.INCONSISTENT` instead of `EXACT`.

This is a genuine, pre-existing bug independent of today's regex change —
any boolean field with this payload shape had the same problem.

### 3c. The fix

Added one field to `readFieldEvidence()`'s returned object:
`value: resolved?.value ?? null` (sourced from the same `resolved` object
already in scope — `resolved.value` correctly preserves the boolean type;
only `.rawValue` gets stringified).

**Why this is minimal and safe:**

- Does not touch `leaseFieldResolver.js`, which is also imported by
  `LeaseDetail.jsx`, `Leases.jsx`, `leaseAbstractService.js`, and
  `leaseRulePipelineService.js` — changing its stringification behavior
  would have been a much higher-blast-radius change than this phase should
  make.
- No regression for non-boolean fields: `sourceTextSupportsValue` already
  prefers `value ?? rawValue`; for strings/numbers, the typed value and its
  stringified form produce the same substring-matchable text, so every
  already-passing test (assignee_name, security_deposit, signature-date
  rejection, markup-artifact rejection, extraction-mode resolution, etc.)
  is unaffected — confirmed by the full test suite (§8).
- Purely an evidence-quality computation input; does not touch
  `approvalBlockers`/gating logic.

## 4. Task B — Clause Records Dedup

**Root cause (confirmed exactly, at the precise line):** the pre-existing
dedup key in `computeFallbackClauseRows()`
(`src/lib/leaseReviewFieldNormalizer.js`) was
`` `${row.clause_title}|${row.source_page ?? ""}|${row.clause_text}` `` —
including `source_page` as part of the uniqueness key. When the same field
appeared in two of the 5 unioned `lease_fields`-shaped payload maps with
identical text but different page-number completeness (one map has a real
page, another doesn't), the two rows got **different** keys and both
survived — exactly the 16-of-35 duplication the Phase 44A audit found.

**Fix:** dedup now keys on normalized `clause_type` + normalized
`clause_title` + normalized `clause_text` (via the newly-exported
`normalizeEvidenceComparable`), with a small `isNearDuplicateClauseText`
helper that also treats a shorter text as a duplicate when it's an exact
prefix of a longer one (≥40 chars) — covering the one observed case where a
truncated cached copy and a fuller copy of the same clause differed by more
than just the page number (the "Tenant Name" clause row, truncated in one
payload map). When two rows collide, the copy with a real `source_page` is
kept over one without; if both/neither have a page, the longer text wins.

Distinct clauses that merely mention the same party/date but have genuinely
different text (different labels, or same label but non-prefix-related
text) are **not** merged — verified by dedicated tests (§7).

## 5. Task C — Rejected Evidence In Clause Records

- **Markup artifacts**: clause rows are now filtered before construction if
  either the resolved value or the source text is a bare markup artifact
  (`isMarkupArtifactValue`, reused from Phase 39/40) — applied to both the
  `lease_clauses`-array path and the `fieldMapRows`-union path. On this
  document, `landlord_name`'s rejected `<figure>` value never actually
  produced a clause row to begin with (confirmed, not just assumed), but
  the guard is now in place and tested for documents where it would.
- **Signature dates sourced from the original lease reference**: clause
  rows whose text matches `isSignatureDateSourcedFromLeaseReference`
  (reused from Phase 39) get `requires_review: true` on their
  `structured_fields_json`, which `normalizeClauseRecords` already turns
  into `reviewStatus: "needs_review"` instead of `"pending"` — no new
  status vocabulary was introduced (this maps directly onto the existing,
  already-styled `needs_review` badge in `LeaseReviewTabTable.jsx`, so no
  table-contract changes were needed).

## 6. Task D — Legal Summaries Preserved

All 19 remaining Clause Records rows were verified individually
(§9) — every genuinely distinct row from the original Phase 44A audit
(Assignor Name fragment, Assumption Scope fragment, Assignment
Consideration, Property Address, etc.) is still present with its original
text; nothing was over-merged. The one row Phase 44A classified as "valid
legal summary" (Lease Term Months / the term-extension sentence) is still
present, just now correctly flagged `needs_review` since its text also
matches the original-lease-reference pattern — its content is fully
preserved, not suppressed.

## 7. Tests Added

| File | New tests |
| --- | ---: |
| `src/lib/__tests__/leaseReviewSchema.test.js` (new file) | 6 |
| `src/lib/__tests__/leaseReviewFieldNormalizer.test.js` | 10 |
| **Total new** | **16** |

Covering: the real sentence and the bare-word backward-compatible case
supporting `true`; unrelated text not supporting a boolean value; polarity-
agnostic behavior preserved for `false`; the other verb-stem keywords
(waive/renew/terminate/require) also matching conjugated forms; a
not-over-broadened boundary check (`"unconsented"` must not match);
`landlord_consent` fixture regression (both the raw evidence-verified
check and the full-pipeline advisory/non-blocker check); Clause Records
dedup for the same field across two payload maps, a truncated/fuller
prefix pair, two same-label-but-genuinely-different-text rows (not
merged), and two same-fact-different-label rows (not merged); markup
artifact suppression (exact bare tag and one wrapped in surrounding
context); signature-date-from-original-lease flagging vs. an ordinary
clause staying `"pending"`.

## 8. Verification

| Check | Result |
| --- | --- |
| `npm run lint` | passed, no errors |
| `npm run typecheck` | passed, no errors |
| `npm run build` | passed with pre-existing Vite chunk-size warnings only |
| `npm run test` | passed, 56 files / 631 tests (615 prior + 16 new) |
| Focused: `leaseReviewSchema.test.js` | 6/6 passed |
| Focused: `leaseReviewFieldNormalizer.test.js` | 42/42 passed |
| Focused: `leaseReviewCurrentPolicy.test.js` / `leaseReviewTabTableContract.test.js` / `leaseReviewUiState.test.js` | 19/19 passed (untouched this phase, included for regression confirmation) |

## 9. Before/After — Approved Document Verification

Re-ran the real `normalizeLeaseReviewData()` against the approved local
rows (fresh read-only local Postgres dump, temporary Vitest files deleted
after each use):

| Check | Before Phase 44A-Fix | After Phase 44A-Fix |
| --- | --- | --- |
| `landlord_consent` value | `true` | `true` (unchanged) |
| `landlord_consent` status | `needs_review` | `auto_populated` |
| `landlord_consent` evidenceVerified | `false` | `true` |
| `landlord_consent` extractionMode | `unknown` | `explicit` |
| `landlord_consent` in `requiredFieldKeys` | no | no (unchanged) |
| `landlord_consent` in `approvalBlockers.missingFields` | no | no (unchanged) |
| `landlord_consent` in `advisoryGaps` | yes | yes (unchanged — this is a policy decision, Phase 36, independent of evidence quality) |
| `approvalBlockers.missingFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `readinessSummary.missingRequiredFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `budgetReadiness` / `camReadiness` | `ready` / `ready` | `ready` / `ready` (unchanged) |
| Original lease missing advisory | present | present (unchanged) |
| Clause Records count | 35 | **19** |
| Clause Records `pending` / `needs_review` | 35 / 0 (all shown as clean, undifferentiated) | 16 / **3** |
| `landlord_name` `<figure>` shown as a clause | not present in this document's data (verified) | still not present (guard now active for other documents) |
| Extraction mode distribution (standard fields) | 11 explicit / 77 unknown | 13 explicit / 75 unknown (`landlord_consent` moved from unknown to explicit; `assignor_name`'s status unaffected) |
| Assignment/full-lease profile behavior | `assignment`, `applyBaseLeaseBlockers: false` | unchanged |
| Action dropdown / table contract | 8 columns, Type hidden, 6 actions | unchanged (not touched this phase) |

## 10. Whether The Two Phase 42 Partials Are Now Fixed

- **Partial 1 (`landlord_consent`): fixed.** `evidenceVerified` is now
  `true` on the approved document, and only because the source text
  genuinely supports the value — verified both by direct unit test against
  the exact sentence and by the full-pipeline fixture/real-data rerun.
- **Partial 2 (Clause Records): fixed.** The duplicate/noise problem found
  in Phase 44A's full audit (16 internal duplicates, rejected evidence
  shown as clean) is resolved — Clause Records count dropped from 35 to 19,
  and the 3 rows carrying original-lease-reference text are now flagged
  `needs_review` rather than presented as clean facts.

## 11. Remaining Gaps

- The `landlord_consent` clause row itself (in Clause Records, separate
  from the standard field) still duplicates the standard field's evidence
  verbatim — this is a "duplicate standard field" classification from the
  original Phase 44A audit that Task B's fix does not address (it targets
  *internal* Clause Records duplication and rejected-evidence display, not
  Clause-Records-vs-standard-field duplication, which was out of scope for
  this fix per the original brief).
- `tenant_name`'s Clause Records row (also a verbatim standard-field
  duplicate carrying the same weak-evidence concern flagged in the
  original Phase 44A audit) was not specifically targeted by Task C's two
  named guards (markup artifacts, signature-date-from-original-lease) and
  remains `pending` rather than flagged — noted as a residual item, not
  silently ignored.
- Track 1's remaining items from Phase 43's signoff packet (a second
  curated document type, a small multi-document QA set) are still
  outstanding.

## 12. Recommendation

**No Gate.** Both Phase 42 partials are now genuinely fixed (not just
root-caused/audited), verified against the real approved document, with no
change to approval-gating behavior, persisted approval state, or
base-lease behavior.

## 13. Recommended Next Step

Continue Track 1 (Phase 43's signoff packet): test at least one more
curated document type to check whether these fixes generalize, and begin
building a small multi-document QA set. Separately, consider whether the
two residual items in §11 (landlord_consent's clause-vs-field duplication,
tenant_name's unflagged weak-evidence clause duplication) warrant their own
small follow-up, or are acceptable as-is given they were outside this
fix's named scope.
