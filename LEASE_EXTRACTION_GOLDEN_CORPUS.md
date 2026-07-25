# Lease Extraction Golden Corpus — Semantic Compatib[text](vscode-webview://0imch8iuk15qpb8taepdstog5jupicm11k6elap53lkn0v6k1q94/LEASE_EXTRACTION_GOLDEN_CORPUS.md)ility Layer

**Status: implemented and tested. Not deployed to production.**

This document reports on a generalized, document-agnostic semantic compatibility
layer added to the lease extraction pipeline, plus the golden test corpus built
to validate it. It supersedes the earlier framing in
`LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md` (which analyzed Craven Wings-specific
symptoms) — this work generalizes the fix to arbitrary lease templates, not one
document.

**Explicit scope boundary, honored throughout:** no code in this change
references Craven Wings, a specific landlord/tenant name, an exact page
number, or a literal sentence copied from a real document. Every production
rule operates on semantic roles and generalized regex patterns. Exact
sentences appear only in test fixtures (`_tests/golden-lease-corpus.test.ts`),
never in production logic.

---

## 1. What was built

### 1.1 Shared semantic role taxonomy

New file: **`supabase/functions/_shared/extraction/semantic-compatibility.ts`**.

Every extracted candidate can now be classified along 8 dimensions, all
defined here as the single source of truth used by both pipelines:

| Dimension | Values |
|---|---|
| `concept` | Carried through from the candidate's own classified category (e.g. `clause:rent_escalation`), or `null`. Informational only. |
| `valueType` | `money \| date \| percentage \| text \| number \| boolean \| unknown` |
| `monetaryRole` | `base_rent, additional_rent, cam, tax, insurance_recovery, utility_charge, allowance, deposit, penalty, reimbursement, amortization, one_time_charge, percentage_rent, unknown` |
| `dateRole` | `execution, signature, effective, delivery, possession, commencement, rent_commencement, expiration, option_exercise, notice, reconciliation, certificate, unknown` |
| `partyRole` | `landlord, tenant, guarantor, broker, property_manager, signatory, assignee, subtenant, lender, unknown` |
| `clauseRole` | `definition, grant, obligation, condition, prohibition, option, default, remedy, surrender, holdover, signature, notice, calculation, unknown` |
| `responsibilityRole` | `performs, pays, maintains, repairs, replaces, insures, reimburses, allocates, approves, unknown` |
| `calculationRole` | `rate, quantity, area, subtotal, total, cap, threshold, percentage, installment, unknown` |

`inferSemanticProfile(input)` is a **deterministic, regex-based classifier**
that computes all 8 dimensions from a candidate's `value`/`sourceText`/
`category` alone — never from which pipeline produced it, and never from a
document identifier. This is what makes it usable by both pipelines
identically (see §1.3).

### 1.2 Per-field semantic compatibility rules (final acceptance gate)

`FIELD_SEMANTIC_REQUIREMENTS` declares explicit `require`/`reject` rules per
role dimension, plus field-specific `custom` checks, for 11 fields:
`monthly_rent`, `annual_rent`, `ti_allowance`, `expiration_date`,
`broker_name`, `tenant_signatory_name`, `renewal_options`,
`electric_responsibility`, `insurance_responsibility`, `tax_responsibility`,
`responsibility_repairs` — the 10 fields Micro-step 0 already tracks
provenance for, plus `tax_responsibility` (a direct generalization of the
`electric_responsibility` "utility/expense category + responsibilityRole=pays"
pattern the task's own field examples describe as a template).

`checkFieldSemanticCompatibility(profile, fieldName, ctx)` is the single
function both pipelines call. A failing check returns
`{ compatible: false, reason }` — a **hard rejection**, per Implementation
rule 3 (never a score penalty). Fields with no entry in
`FIELD_SEMANTIC_REQUIREMENTS` are unaffected by this layer (unchanged
behavior).

Notable rules, matching the task's own field examples exactly:

- **`monthly_rent`**: requires `monetaryRole=base_rent`; rejects
  `additional_rent, cam, tax, insurance_recovery, utility_charge,
  reimbursement, amortization, penalty, percentage_rent, deposit,
  one_time_charge`.
- **`annual_rent`**: same monetary-role gate as `monthly_rent`, plus a custom
  check rejecting a bare monthly-installment phrase with no annual/yearly
  framing.
- **`ti_allowance`**: requires `monetaryRole=allowance`, plus a custom
  formula-aware check: when the source text states an explicit
  `rate x area = total` formula, a candidate whose value matches a left-hand
  operand (rate or area) rather than the computed total is hard-rejected.
  **This closes a real gap this same audit effort originally confirmed** —
  see §4.
- **`expiration_date`**: requires `dateRole=expiration`; rejects `signature,
  execution`.
- **`broker_name`**: requires `partyRole=broker`, plus a custom check
  requiring a named-entity value shape and rejecting generic
  "commissions/fees/costs" language standing in for a name.
- **`tenant_signatory_name`**: requires `partyRole=signatory`, plus a custom
  check requiring signature-block framing (`By:`, `Name:`, `Title:`,
  "authorized representative", etc.) and rejecting generic contract
  boilerplate ("successors and assigns") with no such framing.
- **`renewal_options`**: requires `clauseRole` in `option, grant`; rejects
  `surrender, holdover, default, remedy`.
- **`electric_responsibility`**: requires `monetaryRole=utility_charge` and
  `responsibilityRole=pays`; rejects `repairs, maintains, replaces`.
- **`insurance_responsibility`** / **`tax_responsibility`** /
  **`responsibility_repairs`**: analogous domain + responsibility-role gates.

### 1.3 Wired into BOTH pipelines, from ONE shared module

Per Implementation rules 9 and 10 ("apply to both pipelines," "prefer one
shared post-extraction semantic validator"):

- **`openai_fact_ledger`** — `fact-field-mapper.ts`'s `explainFieldCompatibility()`
  (called from `scoreFactAgainstFieldDetailed()`, the function that already
  gates every candidate before scoring) now also runs
  `checkFieldSemanticCompatibility()` for any tracked field with a semantic
  rule. A failure here forces the candidate's score to `0` — the existing
  code path (`if (!guardResult.passed) return { score: 0, ... }`) already
  treats this as a hard rejection, unchanged from before this work.
- **`legacy_hybrid`** — `merger.ts`'s `mergeField()` is the single point
  where rule-extractor/table/LLM candidates are merged into a final record
  for this pipeline (already the location of the existing
  `evaluateCandidateForField()` domain veto). The same semantic check now
  runs immediately after that veto, before a candidate ever reaches
  confidence-based selection — a failure is pushed to `rejectedCandidates`
  and the candidate is dropped, exactly mirroring the existing veto's shape.

Both call sites import from the same `semantic-compatibility.ts` — there is
one rule table, one classifier, one set of role definitions. This is verified
empirically, not just by code inspection: see the **"parity" tests** in
§3 (Part 9), which run the identical candidate through both pipelines and
assert identical accept/reject outcomes and identical resulting values.

### 1.4 Keyword scoring demoted to retrieval only (Implementation rule 1)

Before this change, `fact-field-mapper.ts`'s label/keyword score was
effectively also the acceptance gate (a `0` score meant "loses," any
positive score meant "can win"). After this change:

- A **semantically incompatible** candidate is hard-rejected before its
  keyword score is ever computed (`scoreFactAgainstFieldDetailed` returns
  `score: 0` immediately).
- A **semantically compatible** candidate's keyword score still determines
  *which* compatible candidate wins when several compete for the same field —
  this is retrieval/ranking, not acceptance, and is unchanged by this work.

### 1.5 Rejected candidates and reasons are preserved (Implementation rule 5)

- `openai_fact_ledger`: a semantically-rejected candidate's reason is threaded
  into `fieldProvenance[field].shapeGuard.reasons` (Micro-step 0's existing
  provenance mechanism) and appears in `rejectedCandidates`, never silently
  dropped.
- `legacy_hybrid`: pushed to `merger.ts`'s existing `RejectedMergeCandidate`
  array with the exact semantic-compatibility reason string.

### 1.6 Explicitly out of scope (Implementation rule 8)

No document-specific literal, landlord/tenant name, page number, or
Craven-Wings-specific condition appears anywhere in
`semantic-compatibility.ts`. Every pattern is a role-level generalization
(e.g. "a sentence naming an insurance premium/coverage/policy" — not "the
Craven Wings insurance clause").

---

## 2. A real, pre-existing gap this layer closed

During test development, the formula-aware `ti_allowance` custom rule caught
and fixed an actual bug that the earlier Micro-step 0 audit had **confirmed
but explicitly deferred**: a fact carrying the AREA operand from a
`rate x area = total` formula (e.g. `2,848` from
`"$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement
Allowance."`) previously had no guard at all for `ti_allowance` and would
silently pass through as the "extracted" value instead of the correct
`$68,352.00` total.

`supabase/functions/_tests/field-provenance.test.ts`'s test
`"field-provenance: ti_allowance's formula-area contamination gap
(originally confirmed by this audit) is now closed by the semantic
compatibility layer"` documents this fix directly: the area-operand candidate
is now hard-rejected (`shapeGuard.passed: false`, `guard:
"ti_allowance_shape_guard"`), and a fact carrying the actual total value is
correctly accepted.

A second, smaller gap was also fixed in the same file: when a tracked field's
*only* candidate(s) failed a guard (rather than merely scoring low), the
provenance-reporting fallback previously overwrote the real rejection reason
with a generic `"No candidate cleared MIN_LABEL_SCORE"` message and
`guard: null`. This has been fixed to surface the actual guard/reason from the
best-ranked rejected candidate instead — purely a diagnostics-fidelity fix,
no change to which value is selected.

---

## 3. Test suite

### 3.1 New files

- **`supabase/functions/_shared/extraction/semantic-compatibility.ts`** — the
  shared module itself (roles, classifier, per-field rules, compatibility
  check).
- **`supabase/functions/_tests/golden-lease-corpus.test.ts`** — 43 tests,
  passing, structured as:
  - **Part 1–6 (28 tests): adversarial sentence bank**, covering every
    category the task specified —
    - Rent: base rent, additional rent, CAM estimate, parking fee, utility
      reimbursement, amortized improvement charge.
    - Dates: signature, effective, commencement, expiration, notice deadline.
    - Entities: broker name, brokerage commissions, signatory name,
      successors-and-assigns boilerplate, property manager.
    - Options: actual renewal grant, holdover clause, surrender clause,
      fair-market-rent option pricing.
    - Formula: rate × area = total, cap/actual-cost limitation, percentage +
      minimum amount.
    - Responsibility: pays vs. repairs-only (electric), generic
      "responsible for" resolving to `pays` (tax).
  - **Part 7 (10 tests): the 10 required fixture categories** — retail NNN,
    office gross, modified gross/base year, industrial, restaurant,
    percentage-rent lease, lease with amendments, scanned rent schedule,
    formulaic commencement date, handwritten signature block. Each builds a
    synthetic multi-fact document (genuine value + at least one misleading
    nearby candidate) and asserts the correct value wins and the misleading
    candidate does not.
  - **Part 8 (3 tests): null correctness** — a document with no compatible
    candidate for a field must resolve that field to `null`/`undefined`,
    never a guess.
  - **Part 9 (3 tests): cross-pipeline parity** — the identical candidate run
    through `mapFactsToStandardFields` (`openai_fact_ledger`) and
    `mergeResults` (`legacy_hybrid`) produces the identical accept/reject
    verdict and the identical resulting value in both.
  - **Part 10 (1 test): scoreboard** — prints and asserts the tallies below.

- **`supabase/functions/_tests/field-provenance.test.ts`** — one test updated
  (see §2), 9/9 passing.

### 3.2 Actual results (from the test run, not assumed)

```
=== GOLDEN CORPUS SCOREBOARD ===
Role classification accuracy: 23/23
Field-acceptance TP/TN/FP/FN: 9/14/0/0 (total 23)
Field-acceptance precision: 1.000
Field-acceptance recall: 1.000
Null accuracy: 3/3
```

`golden-lease-corpus.test.ts`: **43 passed, 0 failed.**

**Honest caveat on these numbers:** precision/recall/null-accuracy here are
computed against ground-truth labels *this same author wrote* for synthetic
fixtures designed specifically to exercise the rules just implemented. A
100% score demonstrates **internal consistency** — the classifier and rule
table behave the way the golden corpus says they should — it is **not**
independent validation against real, unseen lease documents or a live LLM
extraction run (which this sandboxed session has no credentials to perform;
see `LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md` §16.4 for the same limitation
noted previously). Real-world precision/recall can only be established by
running this layer against actual documents in an environment with live
extraction access.

### 3.3 Regression safety — existing suite

Backend, targeted set most relevant to this change (`openai-fact-ledger.test.ts`,
`candidate-decision.test.ts`, `field-contract.test.ts`, `field-provenance.test.ts`,
`lease-schema-new-fields-fixtures.test.ts`,
`lease-review-readiness-and-evidence-guarantees.test.ts`,
`golden-lease-corpus.test.ts`):

```
168 passed | 1 failed
```

The 1 failure (`field-contract.test.ts`, the `tax_responsibility`/
`responsibility_taxes` independence assertion) is **pre-existing and
unrelated** — confirmed by `git stash`-ing every change from this session and
re-running against the original, unmodified code, where it fails identically.

Full-suite baseline diff (`node scripts/compare-deno-baseline.mjs`, which
diffs the failing-test-name set against a checked-in 118-failure baseline
rather than a bare count, so a new regression can't hide behind an unrelated
fix): of the ~280 "new" failures reported, all but one are `.property.test.ts`
/ RLS-lockdown / audit-log / RPC tests that require a live local Supabase
Postgres instance this sandbox does not have (confirmed via direct
`supabaseKey is required` / `connection refused` errors) — the same
environment limitation already documented in
`LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md`. The remaining one is the same
pre-existing `field-contract.test.ts` failure above. **Zero new deterministic,
non-environment-dependent test failures were introduced by this change.**

**Craven Wings regression fixture** (this audit's original motivating case,
now one fixture among many, not the design center): both
`"fact mapper rejects Craven-style unrelated business field values"` and
`"fact mapper keeps Craven-style compatible source-backed use and expense
facts"` in `openai-fact-ledger.test.ts` continue to pass unmodified.

### 3.4 Frontend

`npx vitest run src/`: **78 files, 783 tests, all passed.** No frontend files
were touched by this change — the UI already reads whatever
`mapFactsToStandardFields`/`mergeResults` place into each record's `fields`
object (via `orchestrator.ts` → `ui_review_payload` → `resolveLeaseField`),
so a candidate this layer hard-rejects simply never reaches that object,
exactly like any other pre-existing rejection path. The UI-displays-backend-
selected-value guarantee is therefore inherited from the existing
architecture (verified separately by Micro-step 0's `getFieldDisplayProvenance`
work), not re-implemented here.

---

## 4. Definition of done — checklist

- [x] Production logic is document-agnostic — no Craven Wings / landlord name
      / page number / literal-sentence conditions in `semantic-compatibility.ts`.
- [x] Craven Wings passes as one fixture (§3.3).
- [x] All corpus fixtures pass — 43/43 (§3.2).
- [x] Misleading candidates are rejected semantically, with a hard rejection,
      not a score penalty (§1.4, verified in every adversarial + fixture test).
- [x] Unsupported values remain null (§3.2 Part 8, 3/3).
- [x] Both extraction pipelines use the same compatibility rules — one shared
      module, empirically verified via 3 cross-pipeline parity tests (§3.2
      Part 9).
- [x] UI displays the backend-selected value — inherited from existing
      architecture, unaffected by this change (§3.4).
- [x] Existing regression tests pass — 168/169 targeted, 1 pre-existing
      unrelated failure; full-suite baseline diff shows zero new
      deterministic failures (§3.3).
- [x] No production deployment performed.

## 5. Files changed

- `supabase/functions/_shared/extraction/semantic-compatibility.ts` (new)
- `supabase/functions/_shared/extraction/openai-fact-ledger/fact-field-mapper.ts`
  (wired semantic gate into `explainFieldCompatibility`; fixed the
  provenance-fallback reason-overwrite gap)
- `supabase/functions/_shared/extraction/merger.ts` (wired semantic gate into
  `mergeField`)
- `supabase/functions/_tests/golden-lease-corpus.test.ts` (new, 43 tests)
- `supabase/functions/_tests/field-provenance.test.ts` (1 test updated to
  reflect the closed `ti_allowance` gap)

## 6. Suggested next step

This layer currently covers 11 fields, chosen because they were both
explicitly specified in the task and already had provenance infrastructure
from the prior Micro-step. Extending `FIELD_SEMANTIC_REQUIREMENTS` to the
remaining ~77 schema fields is a natural, bounded follow-up — each additional
field is an isolated table entry, not an architectural change. The other
concrete follow-up is running this layer against a real, live-extracted
document (not a synthetic fixture) once credentials/deployment are available,
to get an honest first read on real-world precision/recall rather than the
internal-consistency numbers in §3.2.
