# Document Intelligence v3 — Phase 42 Final Lease Review Requirements Regression Packet

Generated: 2026-07-15

## 1. Executive Summary

Phase 42 is a reporting/regression-verification phase only — no source code
was changed. It consolidates Phases 33–41 into one final requirements
regression packet for the approved assignment document.

**Final result: 20 requirements tested — 18 Pass, 2 Partial, 0 Fail.**

The 4 real bugs Phase 38 found (split-brain profile detection, signature
dates accepted from the original lease date, `landlord_name` literal
`"<figure>"`, and the missing Extraction Mode column) were all fixed in
Phases 39–40 and reconfirmed working. The 2 remaining Partial rows are both
narrow, pre-existing, low-severity evidence-quality loose ends, not new or
unresolved defects. No requirement fails.

Lease Review is ready for **controlled staging/business review** for this
one approved document. It is **not** ready for approval gating, and the v3
provider-backed claim/evidence architecture is **not** ready for gate use.
Recommendation remains: **No Gate**.

## 2. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

No deploy, remote read, production write, secrets/service-key use,
`SUPABASE_ACCESS_TOKEN`, Azure/Vertex/Gemini call, parse/extraction rerun,
or approval-behavior change occurred in this phase or any phase this
report draws on.

## 3. What Changed Across Phases 33–41

| Phase | What it did | Key result |
| --- | --- | --- |
| 33 | Made current-review policy profile-aware (assignment vs. base lease vs. unknown) | Assignment docs stopped inheriting full base-lease blockers |
| 34–35 | Manual/authenticated visual verification attempts | Confirmed policy logic locally; visual capture partially blocked by auth/browser state |
| 36–37 | Fixed Type column, added action dropdown, downgraded Tenant Name/Landlord Consent to advisory | UI contract matched target; one regression found and fixed in Phase 37 (advisory blocker leak) |
| 38 | Code + local-data verification (no browser tool available) of all 12 original product requirements | Found 3 real bugs: split-brain profile detection, signature-date evidence-integrity bug, `<figure>` invalid markup bug — plus the missing Extraction Mode column |
| 39 | Fixed all 3 evidence-integrity/profile bugs, with an explicit narrow carve-out so the `landlord_name` display fix didn't create a new approval blocker | All 3 bugs fixed; blocker set unchanged (`assignor_name` only) |
| 40 | Added the Extraction Mode column and `resolveLeaseReviewExtractionMode()` data model | 8-column table contract complete; mode resolver never overclaims `explicit` |
| 41 | Business/legal review packet for the Extraction Mode vocabulary | Distribution analyzed (11 explicit / 77 unknown on standard fields); 10-item decision table produced; recommendation to keep the conservative resolver and not invest provider-side yet |
| **42** | **This phase** — final consolidation | 18 Pass / 2 Partial / 0 Fail across 20 requirements |

## 4. Final Requirements Matrix

| Requirement | Expected Behavior | Final Status | Evidence from Phase Reports | Remaining Gap | Owner |
| --- | --- | --- | --- | --- | --- |
| 1. Single consistent Lease Review UI | One component/structure for all profiles; profile changes requiredness, not the whole UI | **Pass** | Phase 39 fixed the split-brain profile detector (`LeaseReview.jsx`'s `isAssignmentOnlyDocument` now derives from `currentReviewPolicy.profile`); Phase 39 §11 rerun confirmed `isAssignmentOnlyDocument` now resolves `true` for the approved document | None | — |
| 2. Profile-aware requiredness | Assignment docs don't inherit base-lease blockers | **Pass** | Phase 33/38/39/40 all confirm `applyBaseLeaseBlockers: false`, `budgetBlockers: []`, `camBlockers: []` for this document | None | — |
| 3. Required missing fields visible | `assignor_name` shown as hard blocker | **Pass** | Consistent across Phases 34–41: `approvalBlockers.missingFields = ["assignor_name"]` every rerun | None | — |
| 4. Optional missing fields hidden or non-blocking | No noisy base-lease field blockers | **Pass** | Phase 38 §2c/§3b: `missingRequired: 0` on all non-required tabs; `showMissingByTab` defaults to hidden | None | — |
| 5. Evidence-first behavior | Populated fields show evidence; weak evidence → Needs Review, not accepted | **Partial** | Phase 39 fixed the two active violations (signature dates, `<figure>`); Phase 38 §4/Phase 39 §10 note `landlord_consent` shows `evidenceVerified: false` despite clear-looking source text, never separately investigated | `landlord_consent` evidence-quality resolution not root-caused | Engineering |
| 6. Source-backed values show page/source text | Page + source text visible where available | **Pass** | Phase 38 §5a/Phase 40 confirm Page and Source Text columns render for all evidence-backed rows | None | — |
| 7. Invalid values are not accepted as facts | No literal markup, no signature-date-from-original-lease acceptance | **Pass** | Phase 39 fixed both; Phase 40 §11 rerun reconfirms `landlord_name: null`, signature dates `needs_review`/`evidenceVerified: false` | None | — |
| 8. Original lease missing is advisory, not fake base-lease failure | Advisory copy, no fabricated field failures | **Pass** | Phase 33/38/39/40/41 all confirm the advisory text is present in `advisoryGaps`/`warnings`, budget/CAM stay `ready` | None | — |
| 9. Budget Preview is read-only / non-duplicative | No editable duplicate fields | **Pass** | Phase 38 §8: `BudgetPreviewCard.jsx` has zero `onChange`/`<input`; all rows `rowType: "read_only_reference"`, `editable: false` | None | — |
| 10. CAM/Expense rules do not create noisy blockers | 0 rules → ready, not a blocker | **Pass** | Phase 38 §9/Phase 40: `camRulesCount: 0`, `camReadiness: "ready"`, `expenseRulesReadiness: "no_rules_found"` | None | — |
| 11. Clause Records remain legal summaries, not duplicate standard facts | Separate row type, no accept/reject wiring | **Partial** | Phase 38 §9c/§10b: structurally confirmed separate (`normalizeClauseRecords`, no `onQuickAction` on the clause tab); content de-duplication only spot-checked on 5 of 35 rows | Full 35-row content audit not performed | Product/QA |
| 12. Table contract (8 columns incl. Extraction Mode) | Field/Term, Value, Status, Confidence, Extraction Mode, Page, Source Text, Action | **Pass** | Phase 38 found this failing (7 columns, no Extraction Mode); Phase 40 fixed it; **re-confirmed directly from current source this phase** (`LeaseReviewTabTable.jsx:130-137`) | None | — |
| 13. Type column not visible | No Type header rendered | **Pass** | Phase 36 fix, held through Phases 37–41; re-confirmed directly from source this phase (`TYPE_META` only used in the filter `<select>`, never as a `<TableHead>`) | None | — |
| 14. Action dropdown contract | Accept, Edit, Mark Needs Review, Mark N/A, Reject, View Source | **Pass** | Phase 36/37 added it; re-confirmed directly from source this phase (`LeaseReviewTabTable.jsx:176-185`, all six items present and wired to `onQuickAction`) | None | — |
| 15. Enrichment banner pending/running only | Exact-match predicate | **Pass** | `isLeaseReviewEnrichmentInFlight` is a 4-line exact `pending`/`running` check with dedicated unit test coverage across all 6 states (Phase 36–41, untouched) | None | — |
| 16. Debug/admin diagnostics gated | Hidden unless superadmin | **Pass** | Phase 38 §12: `extraction_debug` tab trigger and panel both gated behind `isSuperAdminUser` | None | — |
| 17. Assignment blockers correct | `assignor_name` hard; tenant_name/landlord_consent/transfer advisory | **Pass** | Phase 33–41 consistently confirm this exact split; Phase 40/41 rerun reconfirms | None | — |
| 18. Original lease gap advisory/current-truth | Not approval-blocking | **Pass** | Same evidence as Requirement 8 | None | — |
| 19. Extraction Mode conservative, doesn't overclaim explicit | Never claims explicit without real evidence | **Pass** | Phase 40 resolver design + 10 dedicated unit tests; Phase 41 distribution (11 explicit / 77 unknown) shows the conservative behavior in practice on real data | None | — |
| 20. Approval gating unchanged / No Gate | No approval-behavior change across all of Phases 33–41 | **Pass** | Every phase's rerun shows identical `approvalBlockers.missingFields: ["assignor_name"]`; no phase called an approval RPC or mutated persisted approval state | None | — |

## 5. Pass / Partial / Fail Counts

| Result | Count |
| --- | ---: |
| Pass | 18 |
| Partial | 2 |
| Fail | 0 |
| **Total requirements tested** | **20** |

## 6. Remaining Business/Legal Decisions

Full 10-item decision table is in Phase 41 (`docs/document-intelligence-v3-phase41-extraction-mode-business-review.md`, §7). Summary of the open questions, not repeated in full:

1. Should `unknown` be allowed for populated fields?
2. Should `unknown` require Needs Review status?
3. Should `explicit` require source text **and** page (no PARTIAL-quality exception)?
4. Should `normalized` require persisting both raw and normalized values?
5. Should `inferred` require reasoning/context metadata before display?
6. Should `calculated` require formula/provenance before display?
7. Should `reviewer_entered`/`manual` rows show visible reviewer attribution?
8. Should extraction mode reach exports/audit logs?
9. Should extraction mode ever affect approval readiness? (Recommended: not yet)
10. Should non-standard rows (dynamic/clause/expense/CAM) get real extraction mode later, or stay `unknown` until provider-side metadata exists?

None of these block staging review of the current document — they gate any *future* use of extraction mode beyond display.

## 7. Remaining Technical Gaps

| Gap | Classification |
| --- | --- |
| Phase 41's 10-item extraction-mode decision table unresolved | Business/legal decision |
| Richer `inferred`/`calculated`/`normalized` coverage for standard fields | Provider-backed extraction needed |
| Dynamic findings/clause records/expense-CAM rows stuck at `unknown` extraction mode | Provider-backed extraction needed |
| Original lease document missing (current-truth/CAM/budget context) | Evidence/data limitation |
| `landlord_consent` evidence-quality resolution not root-caused | Evidence/data limitation |
| 77 of 88 standard fields show `unknown` extraction mode on this document | Acceptable conservative behavior (per Phase 41's own conclusion) |
| Clause Records 35-row content-duplication audit incomplete (only 5 spot-checked) | Evidence/data limitation |
| No real provider-backed (`vertex_fact_ledger`) run has ever executed — Phase 31A/31B both stopped before any provider call; Phase 29's diagnostic claims/evidence remain reconstructed, not extracted | Provider-backed extraction needed |
| No multi-document curated QA set exists — every phase from 26 through 42 has exercised exactly one approved document | Blocker before staging review (for anything beyond this one document; not a blocker for reviewing this document itself) |

## 8. What Is Ready For Staging Review

- The Lease Review UI, table contract, action model, and profile-aware
  blocker/advisory behavior for **this approved assignment document**, as
  verified end-to-end via real code execution against real local data
  across Phases 38–41.
- The Extraction Mode column and its conservative, non-fabricating resolver.
- The evidence-integrity fixes (no invalid markup shown as fact, no
  signature dates misattributed to the original lease date).

## 9. What Is Not Ready For Approval Gating

- **Approval gating itself** — extraction mode has zero effect on it today,
  by design, and Phase 41's decision table (item 9) explicitly recommends
  keeping it that way until further business/legal sign-off.
- **The v3 provider-backed claim/evidence architecture** — no real
  Vertex/Gemini fact-ledger run has ever completed for this or any document
  (Phase 31A/31B both stopped at the credential-gate); the existing claims/
  evidence are Phase 29's reconstructed diagnostic rows, not real extraction
  output.
- **Multi-document generalization** — every verification in this 42-phase
  arc has been against exactly one document. Nothing here demonstrates the
  fixes generalize to other assignment documents, amendments, base leases
  beyond their own dedicated fixture tests, or edge cases.

## 10. Recommendation

**No Gate.** Recommend proceeding to controlled staging/business review of
Lease Review for the approved assignment document. Do not enable v3
advisory as a hard gate, and do not change approval-gating behavior, until
the Section 6 business/legal decisions are resolved and a real
provider-backed run exists to evaluate.

## 11. Recommended Phase 43

Two independent, non-blocking tracks, either of which can proceed without
waiting on the other:

1. **Business/legal track**: collect actual decisions on Phase 41's 10-item
   table from their named owners (Product, Legal, Compliance, Engineering).
2. **Technical readiness track**: (a) root-cause the `landlord_consent`
   evidence-quality gap (Requirement 5's partial), (b) complete the Clause
   Records 35-row content-duplication audit (Requirement 11's partial), (c)
   begin building a second curated document fixture (e.g. a base lease or a
   second assignment) so the next phase can test generalization instead of
   re-verifying the same single document for a 5th consecutive time.

Do not attempt a real `vertex_fact_ledger` provider run in Phase 43 without
explicit, separate user approval for the provider call itself, per every
prior phase's constraints.
