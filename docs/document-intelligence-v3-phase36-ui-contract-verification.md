# Enterprise Document Intelligence v3 - Phase 36 UI Contract Fix

## Executive Summary

Phase 36 fixed the remaining Lease Review UI contract gaps identified in Phase 35 for the approved assignment document. The changes are current-review/UI-only and keep v3 advisory-only.

Recommendation remains: **No Gate**.

## Approved IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## Constraints Honored

- No deploy.
- No remote read.
- No production write.
- No service-role key use.
- No `SUPABASE_ACCESS_TOKEN` use.
- No Azure call.
- No Vertex/Gemini call.
- No parse or extraction rerun.
- No approval behavior change.
- No Lease Review business-row redesign.
- No global `vertex_fact_ledger` enablement.
- No `BUSINESS_EXTRACTION_PROVIDER` change.
- No v3 advisory hard gate.

## Fixes Made

| Issue | Phase 36 result |
| --- | --- |
| Type column visible in Excel-style tab tables | Removed the visible `Type` table column. Type metadata remains only for filtering/search. |
| Icon-only Accept/Edit/Reject row actions | Replaced row icon cluster with one action dropdown. |
| Required row action labels | Dropdown includes Accept, Edit, Mark Needs Review, Mark N/A, Reject, and View Source for editable standard rows. |
| Tenant Name duplicate hard blocker on assignment | Downgraded assignment `tenant_name` signal to advisory review instead of a hard required blocker. |
| Landlord Consent hard blocker on assignment | Downgraded `landlord_consent` and `landlord_consent_for_transfer` signals to advisory review instead of hard required blockers. |
| Assignor required field visibility | Preserved assignment essentials; `assignor_name` can remain a hard blocker when signaled/relevant. |
| Enrichment banner exactness | Centralized the banner condition so only `pending` and `running` return true. |

## Assignment Blocker Finding

After Phase 36, assignment documents no longer inherit base lease hard blockers and no longer turn Tenant Name or Landlord Consent into duplicate hard blockers. These remain advisory review signals when present. Missing original lease remains an advisory/current-truth gap, not a fake failure for every base lease field.

Expected remaining hard blocker for the approved assignment context is assignment-essential review, especially `assignor_name` when missing/signaled.

## Tenant Name Evidence Finding

The Tenant Name row may still carry source/evidence quality concerns in row-level review because the extracted value is role-sensitive in an assignment. Phase 36 does not fabricate source evidence or promote it to a durable claim. The fix is to prevent that ambiguity from becoming a duplicate hard assignment blocker.

## Browser Verification

The local Vite server was started at `http://127.0.0.1:5173`.

A local headless Edge/CDP check against the approved route redirected to Login because the reusable local browser profile was not authenticated:

`http://127.0.0.1:5173/Login?returnUrl=...LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2`

No production credentials, hosted auth, service-role key, `SUPABASE_ACCESS_TOKEN`, Azure, Vertex/Gemini, parse, or extraction rerun were used. Post-change authenticated visual verification therefore remains blocked by local auth state in this run.

## Automated Verification

| Check | Result |
| --- | --- |
| focused Lease Review policy/UI tests | passed, 3 files / 12 tests |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed with existing Vite chunk/dynamic-import warnings |
| `npm run test` | passed, 55 files / 590 tests |

## Files Changed

- `src/components/lease-review/LeaseReviewTabTable.jsx`
- `src/lib/leaseReviewCurrentPolicy.js`
- `src/lib/leaseReviewUiState.js`
- `src/pages/LeaseReview.jsx`
- `src/lib/__tests__/leaseReviewCurrentPolicy.test.js`
- `src/lib/__tests__/leaseReviewUiState.test.js`
- `src/lib/__tests__/leaseReviewTabTableContract.test.js`
- `docs/document-intelligence-v3-phase36-ui-contract-verification.md`
- `docs/document-intelligence-v3-batch-audit-qa.md`
- `docs/document-intelligence-v3-batch-audit-qa.json`

## Recommendation

**No Gate.**

Phase 36 fixes current Lease Review UI/profile false blocker issues, but v3 remains advisory-only and full provider-backed fact-ledger validation is still not available.

## Recommended Phase 37

Run authenticated local visual verification again after providing or recreating an approved local-only auth session. Confirm the visible Approval Blockers panel only shows assignment-essential hard blockers, the tab table action dropdown opens with all required options, and the enrichment banner appears only for `pending` or `running` enrichment status.
