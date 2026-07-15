# Document Intelligence v3 — Phase 43 Signoff Decision Packet

Generated: 2026-07-15

## 1. Executive Summary

Phase 43 is decision/reporting only — no source code was changed. It
packages Phase 42's final result (20 requirements: 18 Pass / 2 Partial / 0
Fail) into a signoff packet aimed at real decision owners, and defines two
independent next tracks. This phase does not create new technical
requirements, does not reopen or re-score the Phase 42 requirements matrix,
and does not decide which track happens next — that choice belongs to the
user/business.

**Bottom line:** the approved assignment document's Lease Review is ready
for controlled staging/business review. It is not ready for broad
production release or approval gating. Recommendation remains: **No Gate**.

## 2. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## 3. Final Phase 42 Result

| Metric | Value |
| --- | --- |
| Requirements tested | 20 |
| Pass | 18 |
| Partial | 2 |
| Fail | 0 |

The 2 Partial items (both restated, not re-scored, here):

1. **`landlord_consent` evidenceVerified: false** despite clear-looking
   source text — root cause not yet identified.
2. **Clause Records content de-duplication** — structurally confirmed
   separate from standard fields, but only spot-checked on 5 of 35 rows,
   not a full audit.

Full detail: `docs/document-intelligence-v3-phase42-final-lease-review-regression.md`.

## 4. What Is Ready For Controlled Staging Review

- The full Lease Review UI, table contract (8 columns including Extraction
  Mode), action model (Accept/Edit/Mark Needs Review/Mark N/A/Reject/View
  Source), and profile-aware blocker/advisory behavior for the approved
  assignment document — verified end-to-end via real code execution against
  real local data across Phases 38–42.
- The three evidence-integrity fixes (no invalid markup shown as fact, no
  signature dates misattributed to the original lease date, consistent
  profile detection between the banner and the blocker logic).
- The Extraction Mode column and its conservative, non-fabricating
  resolver (11 explicit / 77 unknown on this document's 88 standard fields
  — an honest distribution, not an inflated one).

## 5. What Is Not Ready For Approval Gating

- **Approval gating itself.** Extraction mode has zero effect on it today,
  by design. Nothing in Phases 38–42 changed that, and Phase 41's own
  decision table recommends keeping it that way pending business/legal
  sign-off (see §6, item 8 below).
- **The v3 provider-backed claim/evidence architecture.** No real
  Vertex/Gemini `vertex_fact_ledger` run has ever completed for this or any
  document — Phase 31A/31B both stopped at the credential/scoped-config
  gate before any provider call. The existing claims/evidence in the local
  diagnostic run are Phase 29's reconstructed rows, not real extraction
  output.
- **Multi-document generalization.** Every verification across Phases
  26–42 has been against exactly one approved document. Nothing
  demonstrates the fixes generalize to other assignment documents,
  amendments, base leases beyond their own isolated fixture tests, or edge
  cases.

## 6. Business/Legal Decision Checklist

| # | Question | Recommendation | Basis |
| - | --- | --- | --- |
| 1 | Is Assignor Name the correct remaining hard blocker for assignment documents? | **Yes** | Confirmed correct and unchanged across Phases 33–42 (`approvalBlockers.missingFields = ["assignor_name"]` in every rerun) |
| 2 | Should Tenant Name remain advisory when assignor/assignee roles exist? | **Yes, keep advisory** | Phase 36–39 fix; Phase 42 Requirement 17 confirms pass |
| 3 | Should Landlord Consent remain advisory, become conditional, or become hard required? | **Keep advisory for now** | Phase 42 Requirement 5's open partial (evidenceVerified false on clear-looking text, root cause unknown) means tightening this today would gate on a signal not yet understood — resolve the root cause first (Track 1) |
| 4 | Should Transfer/consent language remain advisory? | **Yes** | Consistent with the Landlord Consent decision above; same evidentiary basis |
| 5 | Should Original Lease missing remain advisory/current-truth rather than a hard blocker? | **Yes** | Confirmed correct and load-bearing across every phase since Phase 28; converting it to a hard blocker would re-introduce the "false full-lease blocker" problem the whole 33–39 arc fixed |
| 6 | Is the conservative Extraction Mode vocabulary acceptable? | **Yes** | Phase 41's own conclusion: the conservative default is doing its job (real reasons behind every `unknown`), not failing at coverage |
| 7 | Should Unknown extraction mode force Needs Review? | **Open — no recommendation** | Genuinely undecided (Phase 41 decision table item 2). Case for: a populated-but-`unknown` field is exactly the case most needing a human look. Case against: could conflict with an already-correct `status` computed independently, and would couple two currently-independent signals |
| 8 | Should Extraction Mode affect approval readiness in the future? | **Not yet** | Phase 41 decision table item 9's own recommendation — premature until Decisions 2, 3, 6, 7 above are resolved and a curated document set validates mode accuracy |
| 9 | Should extraction mode be included in exports/audit logs? | **Lean yes, once vocabulary decisions are locked** | Phase 41 decision table item 8: useful for downstream auditability, but sequencing matters — export the vocabulary only after Decisions 2, 3, 6, 7 are settled, not before |
| 10 | Are Clause Records acceptable as legal summaries, with no standard-field duplication? | **Acceptable for staging review as-is** | Structural separation confirmed (distinct normalizer, no `onQuickAction` wiring); the outstanding 5-of-35-row spot-check limit (Phase 42 Requirement 11) is a completeness gap, not a known defect — full audit belongs in Track 1, not a precondition for staging review |

## 7. Product Decision Checklist

| # | Question | Answer |
| - | --- | --- |
| 1 | Is the approved assignment Lease Review ready for controlled staging review? | **Yes** |
| 2 | Is it ready for broad production release? | **Not yet** — single-document verification only; no multi-document QA set exists |
| 3 | Is it ready for approval gating? | **No** — extraction mode and the v3 provider-backed architecture are both non-gate-ready (§5) |
| 4 | What signoffs are required before staging review? | None blocking — Decisions 1, 2, 4, 5, 6 in §6 are already resolved with clear recommendations; Decisions 3, 7, 8, 9, 10 are open but do not block staging review of *this* document specifically |
| 5 | What signoffs are required before approval gating? | All 10 items in §6 resolved (not just recommended — actually decided by their owners), plus a completed Track 2 provider-backed comparison (§8) and a multi-document QA set (Track 1) |

## 8. Engineering/QA Decision Checklist

| # | Item | Status | Note |
| - | --- | --- | --- |
| 1 | `landlord_consent` evidenceVerified root cause | Open | Track 1 item |
| 2 | Clause Records full 35-row content audit | Open | Track 1 item |
| 3 | Second curated document type (base lease or another assignment) | Not started | Track 1 item — needed to test whether Phase 33–40's fixes generalize beyond this one document |
| 4 | Multi-document QA fixture set | Not started | Track 1 item |
| 5 | Real `vertex_fact_ledger` provider-backed run | Never executed | Track 2 item — Phase 31A/31B stopped at the credential gate |
| 6 | Provider-backed vs. reconstructed-diagnostic claims comparison | Not possible yet | Depends on item 5 |

## 9. Open Technical Caveats

Restated from Phase 42 (no new items introduced this phase):

1. `landlord_consent`'s `evidenceVerified: false` despite clear-looking
   source text — root cause not completed.
2. Clause Records content de-duplication only spot-checked on 5 of 35
   rows, not a full audit.

## 10. Recommended Next Tracks

### Track 1 — Lease Review Hardening

- Root-cause `landlord_consent`'s `evidenceVerified: false` result.
- Complete the full Clause Records content de-duplication audit (all 35
  rows, not a 5-row sample).
- Test at least one more curated document type (e.g. a base lease or a
  second, different assignment document) to check whether Phases 33–40's
  fixes generalize beyond the single approved document.
- Build a small multi-document QA set from the results.

### Track 2 — v3 Provider-Backed Evidence

- Configure scoped local/staging Vertex/Gemini provider credentials
  (explicitly scoped to one document, not a global enablement).
- Run exactly one provider-backed `vertex_fact_ledger` attempt.
- Compare the provider-backed claims/evidence against Phase 29's
  reconstructed diagnostic claims/evidence.
- Only after that comparison, consider broader v3 claim/evidence QA.

**Track 2 requires its own separate, explicit future user approval before
any real provider call is made** — this packet does not authorize that
call; it only defines the track for future consideration, consistent with
every prior phase's provider-call constraints (Phase 31A/31B/38–42).

Both tracks are independent and can proceed in either order, or in
parallel, at the user's discretion. This phase does not choose between
them.

## 11. Recommendation

**No Gate.** Recommend proceeding with controlled staging/business review
of Lease Review for the approved assignment document. Do not enable v3
advisory as a hard gate, and do not change approval-gating behavior, until
the §6 business/legal decisions are resolved by their actual owners and a
real provider-backed comparison (Track 2) exists to evaluate against.
