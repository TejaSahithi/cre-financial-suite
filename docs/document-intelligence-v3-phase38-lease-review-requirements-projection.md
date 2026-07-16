# Document Intelligence v3 — Phase 38 Lease Review Requirements Projection

Generated: 2026-07-15

## 1. Method (read before the table)

This phase was scoped as an authenticated local UI verification, but **this
session had no browser automation tool available** (no Playwright/Puppeteer/
CDP-capable tool registered, and none installed in the repo —
`package.json`/`node_modules` confirmed clean). Phases 34–37's "isolated
headless browser" / "local headless Edge/CDP check" relied on an external
tool this session does not have. Per explicit user decision, Phase 38
substitutes **code + local data verification**:

1. The two approved rows were read **directly from local Postgres**
   (`127.0.0.1:54322`, `supabase_db_cre-financial-suite-main`, read-only
   `SELECT`, no writes) — `leases.id = 7b21f353-579d-48e8-b3dd-8e8c49743fe2`
   and `uploaded_files.id = fc8181e6-766d-49c7-b81b-b5d961160207`. Dumps were
   written only to the local scratchpad, never committed.
2. The **real, unmodified production function**
   `normalizeLeaseReviewData(leaseFull, { fieldReviews })` (`src/lib/
   leaseReviewFieldNormalizer.js:729-762`) — the exact function
   `LeaseReview.jsx` itself calls to render the page — was executed against
   those two rows via a temporary Vitest file (so Vite's `@/` path aliases
   resolve). `leaseFull` and `fieldReviews` were reconstructed exactly as
   `LeaseReview.jsx` builds them (lines 256–260, 360). The temporary test
   file was **deleted immediately after the run**; `git status --short`
   confirms no `src/` changes remain from this phase.
3. Static UI-contract facts that data alone can't prove (table columns,
   dropdown wiring, read-only-ness, admin gating) were confirmed by **direct
   source read this session**, cited by file:line below.
4. Phase 37's prior authenticated visual capture is cited only where it adds
   information beyond what code+data this session already re-derived.

**This is not a fresh browser/DOM capture.** Anywhere the matrix says "PASS"
based on code/data alone, that means the underlying logic and data support
the requirement — it does not mean a human or automated agent watched pixels
render in a browser this session.

Local environment confirmed running: Supabase Kong `127.0.0.1:54321`,
Supabase DB `127.0.0.1:54322`, Vite dev server `127.0.0.1:5173` (HTTP 200).
No deploy, remote read, Azure/Vertex/Gemini call, parse/extraction rerun, or
approval-behavior change occurred.

## 2. Requirements Matrix

| # | Requirement | Expected Behavior | Actual UI Behavior | Pass/Fail | Evidence/Notes | Fix Needed |
| - | --- | --- | --- | --- | --- | --- |
| 1a | Single consistent Lease Review UI | Assignment doc uses the same Lease Review component/structure as any other profile | Confirmed — `LeaseReview.jsx` is the only page component; there is no separate assignment-specific route or component tree | PASS | Single 4100+ line component renders all profiles; profile only changes which sections/blockers are active | No |
| 1b | Profile changes requiredness/relevance, not the entire UI | One profile-detection result should drive all profile-aware branches consistently | **Two independent, disagreeing profile detectors exist.** `currentReviewPolicy.profile` (via `resolveCurrentReviewProfile`, which scans multiple payload paths) correctly resolves `"assignment"` for this document. But the simpler `detectDocumentProfile(leaseFull)` (`src/lib/documentProfile.js`) — used directly by `LeaseReview.jsx:934` for `isAssignmentOnlyDocument` — returned **`"unknown"`** for this exact document (no full-lease signals, and `documentType` string didn't match/contain an assignment-type token in this payload). `isAssignmentOnlyDocument` gates: the Assignment/Amendment/Consent banner (`LeaseReview.jsx:2906`), which banner shows instead when false (`:2928`, `:2962`), and `FULL_LEASE_ONLY_TABS` hiding (`:3146`). All three do **not** engage for this approved document, even though the blocker/readiness UI (driven by `currentReviewPolicy`) correctly treats it as an assignment. | **FAIL** | Verified directly this session: `detectDocumentProfile(leaseFull)` on the actual approved row returns `"unknown"` (see scratchpad `phase38-normalizer-report.json`, `profile` key), while `currentReviewPolicy.profile` returns `"assignment"` from the same `leaseFull` object. `documentProfile.js:110-111` comment: *"No signals either way — default to unknown (UI treats it as full lease)."* | Yes — reconcile so `isAssignmentOnlyDocument`/banner/tab-hiding use the same profile resolution as `currentReviewPolicy` (or have `detectDocumentProfile` itself use the broader candidate scan), not two parallel classifiers that can disagree on the same document. |
| 2a | Assignment docs do not inherit full base-lease blockers | `approvalBlockers.missingFields` excludes base-lease-only fields | `missingFields: ["assignor_name"]` only | PASS | `phase38-normalizer-report.json` → `approvalBlockers.missingFields` | No |
| 2b | Base lease economics/CAM/budget blockers are not hard blockers | `budgetBlockers`/`camBlockers` empty for assignment profile | Both `[]` | PASS | `approvalBlockers.budgetBlockers: []`, `camBlockers: []`; `applyBaseLeaseBlockers: false` | No |
| 2c | Unknown/optional base-lease fields hidden or non-blocking by default | Missing optional fields shouldn't appear as blockers, and the default tab view hides them | Non-blocking confirmed (`missingRequired: 0` on all non-required tabs). Default-hidden confirmed structurally — `LeaseReview.jsx:289-292`: `showMissingByTab` state defaults to `{}` / false per tab, comment states *"false = extracted only (default)"* | PARTIAL | Non-blocking status confirmed from live data; the hide-by-default filter itself was confirmed by reading the state declaration, not by re-deriving the exact filtered row count this session | No — behavior is correct; note is only that the exact rendered row count wasn't independently recomputed |
| 2d | Assignor Name remains required if absent | Shows as hard blocker when missing | `assignor_name`: `value: null, status: "missing"`, in `missingFields` | PASS | Field has source text present (`evidenceVerified: true`) but no extractable value — correctly still blocks | No |
| 2e | Tenant Name is not a duplicate hard blocker when assignment roles exist | Advisory only | `tenant_name` appears only in `advisoryGaps` (`tenant_name_assignment_advisory`, severity `needs_review`), not in `missingFields` | PASS | `currentReviewPolicy.advisoryGaps` | No |
| 2f | Landlord Consent / Transfer advisory unless business policy says otherwise | Advisory only, not hard blocker | `landlord_consent` in `advisoryGaps` (advisory); `landlord_consent_for_transfer` has no signal in this document (null) so it doesn't appear in either blockers or advisories | PASS | `currentReviewPolicy.advisoryGaps`; `fieldsOfInterest.landlord_consent_for_transfer` = missing/no signal | No |
| 2g | Original lease missing is advisory/current-truth gap | Advisory warning, not a field blocker | `advisoryGaps` includes `original_lease_missing` with exact advisory copy; not in `missingFields` | PASS | `currentReviewPolicy.advisoryGaps[0]` | No |
| 3a | Required missing assignment fields remain visible | `assignor_name` visible as blocker | Confirmed (see 2d) | PASS | Same as 2d | No |
| 3b | Missing optional fields hidden by default or advisory only | See 2c | Same finding as 2c | PARTIAL | Same as 2c | No |
| 4a | Populated fields show page/source text when available | `sourceText`/page present on populated rows | Confirmed for `assignee_name`, `assignment_effective_date`, `landlord_consent`, `tenant_signature_date`, `landlord_signature_date`, `landlord_name` | PASS | `fieldsOfInterest.*` in `phase38-normalizer-report.json` | No |
| 4b | Fields without valid evidence are Needs Review/advisory | Weak-evidence fields get `needs_review`, not `auto_populated` | `tenant_name`: `status: "needs_review"`, `evidenceVerified: false` despite a value being present | PASS | `fieldsOfInterest.tenant_name` | No |
| 4c | Tenant Name not treated as accepted/source-backed when evidence is weak | Same as 4b | Confirmed not `auto_populated` | PASS | Same as 4b | No |
| 4d | **Invalid signature dates sourced from the original lease date should not appear as accepted facts** | Per architecture doc §10: *"Original lease date cannot become assignment signature date"* — such values should be validation-dropped, not shown as accepted | **They are shown as accepted.** Both `tenant_signature_date` and `landlord_signature_date` resolve to `2018-02-01`, **`status: "auto_populated"`**, **`evidenceVerified: true`**, with source text *"...entered into that certain Lease dated February 1, 2018"* — which is explicitly the **original lease date**, not a signature date. | **FAIL** | `fieldsOfInterest.tenant_signature_date` / `landlord_signature_date` in `phase38-normalizer-report.json`. Contrast: the separate v3 diagnostic layer (Phase 29/30) *does* correctly drop these exact two fields with reason `signature_date_sourced_from_original_lease_date` — but that drop lives only in `document_validation_drops` for the v3 diagnostic run, and is never applied to the `standardFields`/`normalizeStandardFields` path that the live Lease Review page actually renders. | **Yes** — port the same signature-date-vs-original-lease-date validation rule into `leaseReviewFieldNormalizer.js`'s current-review field resolution (or the underlying `leaseReviewSchema.js` resolver), so the live UI doesn't show it as `auto_populated`/evidence-verified. |
| 4e | Invalid markup should not be treated as a valid field value | Per architecture doc §10: *"Invalid markup is rejected: `<figure>`, `<table>`, `<tr>`, `<td>`"* | **Not rejected.** `landlord_name` resolves to the literal string **`"<figure>"`** as its `value`, `status: "needs_review"`, `confidence: 92` — still displayed as the field's value rather than dropped/blanked | **FAIL** | `fieldsOfInterest.landlord_name`. This is the same specific defect named in the architecture doc's §19 "Immediate Fixes" item #2 (*"Landlord Name cannot be `<figure>`; recover Montvue, LLC from page 1 or mark missing"*) — still unresolved as of Phase 38, even though `landlord_name` isn't a hard blocker for this assignment profile so it doesn't block approval today | **Yes** — apply the invalid-markup rejection rule from the architecture spec in the current-review field resolver, same as 4d |
| 5a | Table shows exactly: Field/Term, Value, Status, Confidence, **Extraction Mode**, Page, Source Text, Action | 8 columns per task brief / v3 architecture §15 | `LeaseReviewTabTable.jsx:116-122` (`colSpan={7}` at :128 confirms count) renders only **7** headers: `Field / Term, Value, Status, Confidence, Page, Source Text, Action`. **No Extraction Mode column.** Deeper: the row model itself has no independent `extractionMode`/`extraction_mode` property either — `standardFieldsSample` keys (`phase38-normalizer-report.json`) list `status`, `extraction_status`, `sourceProvider`, etc., but nothing distinguishing explicit vs. inferred vs. calculated vs. reviewer-entered as its own axis. `EXTRACTION_STATUSES` (`leaseReviewSchema.js:1004-1016`) conflates status and mode into one enum, and only expense/CAM rule-derived fields ever get stamped `"calculated"` (`leaseReviewSchema.js:553-583`) — most standard fields get neither. No documented product decision to omit Extraction Mode was found in Phases 33-37 (Phase 36's fix list only mentions removing Type and adding the action dropdown). | **FAIL** | Direct source read this session, cross-checked against live row-object keys | **Yes** — this is two gaps: (1) add the model, not just the column — most standard fields need an explicit/inferred/calculated/reviewer-entered tag before a real "Extraction Mode" value exists to show; (2) then render the column |
| 5b | Type column is not visible | Removed per Phase 36 | Confirmed absent | PASS | `LeaseReviewTabTable.jsx:116-122` | No |
| 5c | Action dropdown is visible | One dropdown menu per row, not icon buttons | Confirmed — `DropdownMenuTrigger`/`DropdownMenuContent` at `:151-173` | PASS | Source read | No |
| 5d | Rows are readable and Excel-style | Standard table layout | Standard `<Table>`/`<TableRow>`/`<TableCell>` shadcn components, one row per field | PASS | Source read; consistent with Phase 37's visual capture | No |
| 6a | Dropdown contains Accept, Edit, Mark Needs Review, Mark N/A, Reject, View Source | All six present | Confirmed all six as `DropdownMenuItem`s (`:151-173`) | PASS | Source read | No |
| 6b | Accept works (or is wired) | Calls a real persisting handler | `onQuickAction(row, "accept")` → `LeaseReview.jsx:1664-1672` `handleTabRowQuickAction` → `handleAccept` (re-reads fresh lease, persists) | PASS | Source read; **not interactively clicked this session** (no browser) | No |
| 6c | Edit works (or opens edit flow) | Opens field detail drawer in edit mode | `→ "edit"` dispatches to `openDrawer(row, "edit")` | PASS | Source read; not interactively clicked this session | No |
| 6d | Reject works (or is wired) | Calls a real persisting handler | `→ handleReject` → shared `persistFieldAction(...)` | PASS | Source read; not interactively clicked this session | No |
| 6e | Mark Needs Review present | Menu item exists and is wired | `→ handleNeedsLegal` | PASS | Source read | No |
| 6f | Mark N/A present | Menu item exists, disabled when `row.allowNA === false` | `→ handleMarkNA`, correctly conditional | PASS | Source read | No |
| 6g | View Source present, works if source available | Disabled unless `hasSourceEvidence` | Confirmed — falls back to `onOpenDetail` (drawer "view" mode) if no dedicated handler | PASS | Source read | No |
| 7a | Original lease missing shown as advisory/current-truth gap | Advisory copy, not a field failure | Confirmed — `advisoryGaps[0]` exact text: *"Original lease is needed for full CAM, budget, and current-truth analysis. This is advisory and does not create base-lease field blockers."* | PASS | `currentReviewPolicy.advisoryGaps` | No |
| 7b | Does not create fake failures for base rent, CAM, premises, term, etc. | Those stay non-blocking | `budgetBlockers: []`, `camBlockers: []`, `budgetReadiness: "ready"`, `camReadiness: "ready"` | PASS | `approvalBlockers`, `readinessSummary` | No |
| 7c | Related-document gap visible enough for reviewer understanding | Clear advisory text surfaced in warnings | Same text also surfaces in `approvalBlockers.warnings` (shown to reviewer wherever warnings render) | PASS | `approvalBlockers.warnings[0]` | No |
| 8a | Budget Preview is read-only | No editable inputs | `BudgetPreviewCard.jsx` — zero matches for `onChange`/`<input`/`<Input`/`editable` in the file; all `budgetPreview` rows from the normalizer are `rowType: "read_only_reference"`, `editable: false` | PASS | Source grep + `phase38-normalizer-report.json` `budgetPreview` array | No |
| 8b | No editable duplicate fields | Same as 8a | Confirmed | PASS | Same as 8a | No |
| 8c | Budget shows ready/non-blocking for this document | `budgetReadiness: "ready"` | Confirmed, `budgetMissingInputsCount: 0` | PASS | `readinessSummary.budgetReadiness` | No |
| 9a | CAM shows ready/no rule rows when no CAM rules present | `camRulesCount: 0`, `camReadiness: "ready"` | Confirmed | PASS | `readinessSummary.camReadiness`, `camRulesCount` | No |
| 9b | Expense/recovery clauses do not create noisy blockers | `expenseRulesReadiness` informational, not a blocker | `expenseRulesCount: 0`, `expenseRulesReadiness: "no_rules_found"` — informational status, not in `missingFields` | PASS | `readinessSummary.expenseRulesReadiness` | No |
| 9c | No duplicate clause records appear as standard field facts | Clause rows architecturally separate from standard fields | `normalizeClauseRecords` is a distinct function from `normalizeStandardFields`; the Clause Records tab passes no `onQuickAction` (`LeaseReview.jsx:3352-3354`), so clause rows can't be Accept/Reject'd as facts. Content-level duplication was spot-checked on a 5-row sample only (not all 35 rows) | PARTIAL | Structural separation confirmed by source; full 35-row content audit not performed this session | No — structure is correct; a full content audit is optional follow-up, not required |
| 10a | Clause Records remain legal summaries/evidence | Rows carry source text + confidence, not field key/value pairs | Sample rows show clause-style source-text quotes (e.g. full recital paragraph, assignment/assumption language) | PASS | `clauseRecordsSample` in `phase38-normalizer-report.json` | No |
| 10b | Do not duplicate standard field facts noisily | Same caveat as 9c | Same as 9c | PARTIAL | Same as 9c | No |
| 10c | Dynamic findings appear in related tabs, not top-level noise | N/A for this document | `dynamicFindingsCount: 0` — nothing to check for this specific document | PASS (N/A) | `phase38-normalizer-report.json` `dynamicFindingsCount` | No |
| 11 | Enrichment banner appears only for `pending`/`running`, not completed/failed/null/undefined/stale | Exact-match predicate | `isLeaseReviewEnrichmentInFlight` (`leaseReviewUiState.js`, 4 lines) is an exact `=== "pending" \|\| === "running"` check, unit-tested against all 6 states (`leaseReviewUiState.test.js`). For this document, `enrichment_status` is currently `"running"`, so the banner **correctly** shows | PASS | Source read + `phase38-normalizer-report.json` `enrichmentStatus`/`enrichmentInFlight` | No |
| 12a | Debug/admin diagnostics hidden unless admin/superadmin | Gated by role | `extraction_debug` tab trigger hidden unless `isSuperAdminUser` (`LeaseReview.jsx:3135`); panel content also gated (`:3377-3381`) | PASS | Source read | No |
| 12b | Business UI not polluted with diagnostic internals | Same gate | Same as 12a; `ExtractionDebugPanel` only renders inside the gated block | PASS | Source read | No |

## 3. Tally

| Result | Count |
| --- | ---: |
| PASS | 28 |
| PARTIAL | 4 |
| FAIL | 3 |
| **Total requirements tested** | **35** |

## 4. Gap Classification (Task C)

Every non-PASS row, classified per the requested taxonomy: bug / business
policy question / missing data-evidence / provider-backed extraction needed /
acceptable limitation for assignment document.

| # | Requirement | Classification | Reasoning |
| - | --- | --- | --- |
| 1b | Split-brain profile detection | **Bug** | Two profile classifiers exist for the same document and disagree; not a data gap or policy question — `detectDocumentProfile` should either be reconciled with or replaced by `resolveCurrentReviewProfile`'s more robust scan |
| 2c / 3b | Missing-optional-field hide-by-default not re-derived this session | **Acceptable limitation for this phase** | Behavior is structurally correct (`showMissingByTab` defaults to hidden); only the exact rendered count wasn't independently recomputed without a browser. Not a product gap |
| 4d | Signature dates accepted from original lease date | **Bug** | Architecture doc explicitly forbids this (§10); the v3 diagnostic layer already implements the correct drop rule — this is a known-correct rule not yet applied to the path users actually see |
| 4e | `landlord_name` = `"<figure>"` | **Bug** | Architecture doc explicitly forbids invalid markup as a value (§10); named as an unresolved defect in the doc's own §19 immediate-fix list |
| 5a | Extraction Mode column/model missing | **Bug (column) + missing data-model (underlying gap)** | No documented decision to omit it; Phase 36's fix list never mentions it. The column gap is a straightforward render fix once the property exists, but most fields don't carry an explicit/inferred/calculated tag today — that's a data-model gap, not just a UI oversight, and may need extractor-side support (provider-backed) to be meaningful beyond the handful of rule-derived `"calculated"` fields that already exist |
| 9c / 10b | Clause Records duplication not fully audited across all 35 rows | **Acceptable limitation for this phase** | Structural separation (distinct normalizer, no accept/reject wiring) is correct; a full 35-row content audit is a reasonable follow-up, not a required fix |
| — | `tenant_name` remains source-less/needs-review | **Missing data-evidence** (pre-existing, reconfirmed) | Consistent with Phases 30/34/37 — value exists but no source text actually supports it; correctly held at `needs_review`, not a bug |

## 5. Summary

Lease Review projects the **profile-aware blocker/readiness requirements
correctly** for the approved assignment document — the work done in Phases
33–37 holds up under direct code+data verification (`assignor_name` is the
only hard blocker; base-lease/CAM/budget blockers stay empty; original lease
missing is advisory).

Three real, previously-undetected requirement failures came out of this
deeper check, none caught by Phases 34–37's checklist because their
checklists didn't ask these exact questions:

1. **Split-brain profile detection (1b)** — `detectDocumentProfile()` (used
   for the assignment banner and full-lease-tab hiding) disagrees with
   `currentReviewPolicy.profile` (used for blockers) on this exact document.
2. **Signature dates sourced from the original lease date are shown as
   accepted facts (4d)** — a direct violation of the architecture doc's own
   validation rule, and a regression relative to the v3 diagnostic layer,
   which already gets this right in a table nobody's looking at.
3. **`landlord_name` still resolves to literal `"<figure>"` (4e)** — the
   exact defect named in the architecture doc's immediate-fix list, still
   present.
4. **Extraction Mode column/model is entirely missing (5a)** — both the
   column and the underlying per-field data needed to populate it correctly.

None of these are approval-gating today (the assignment blocker set is still
correct), but 4d and 4e mean reviewers can see incorrect-looking accepted
values without any Needs-Review signal, which is a trust-in-the-tool problem
independent of the approval gate.
