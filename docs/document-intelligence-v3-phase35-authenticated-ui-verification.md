# Enterprise Document Intelligence v3 - Phase 35 Authenticated UI Verification

## Executive Summary

Phase 35 established an authenticated local-only test session and reached the approved Lease Review screen for lease `7b21f353-579d-48e8-b3dd-8e8c49743fe2` at `http://127.0.0.1:5173`.

The visible UI reflects the Phase 33 profile-aware current-review policy in the important blocker areas:

- the page shows profile context as `assignment`
- the advisory blocker copy says assignment/amendment documents are not held to full-lease requirements
- full base-lease economics/CAM fields are not shown as hard approval blockers
- Budget and CAM readiness are shown as ready/no rule rows rather than hard blockers
- original lease missing is shown as advisory/current-truth context

Remaining UI issues were also found:

- visible Approval Blockers show 3 required blockers: `Tenant Name`, `Assignor Name`, and `Landlord Consent`, not only `assignor_name`
- the row table still includes a `Type` column
- row actions are icon buttons for Accept/Edit/Reject, not an action dropdown with Mark Needs Review, Mark N/A, and View Source
- enrichment banner is visible because enrichment status is pending/running; this appears consistent, but should be rechecked after enrichment completes

Recommendation remains: **No Gate**.

## Authenticated Local Session Method

A local-only Supabase Auth user was created through the local Supabase Auth API at `http://127.0.0.1:54321`. Local-only `profiles`, `memberships`, and `user_roles` rows were added for the approved local org so the normal app auth/routing path could load Lease Review.

MFA enrollment was completed only for that local test user in the local browser session. Passwords, MFA codes, tokens, and auth storage were not printed or committed.

No production credentials, hosted auth, service-role key, or `SUPABASE_ACCESS_TOKEN` were used.

## Local Environment Verified

| Check | Result |
| --- | --- |
| app URL | `http://127.0.0.1:5173` |
| approved route | `/LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| frontend Supabase URL | `http://127.0.0.1:54321` |
| local Supabase DB | `127.0.0.1:54322` |
| hosted endpoint used | no |
| production write endpoint used | no |
| remote read performed | no |
| Azure call made | no |
| Vertex/Gemini call made | no |
| parse/extraction rerun | no |
| approval behavior changed | no |
| v3 advisory hard gate enabled | no |

## Approved Document IDs

| ID type | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## Visual UI Checklist Results

| Area | Result | Notes |
| --- | --- | --- |
| authenticated Lease Review reached | yes | Local session reached `/LeaseReview?id=...`; no Login/MFA screen remained. |
| profile/policy behavior | pass | UI shows `assignment` and profile-aware advisory copy. |
| full base-lease economics hard blockers | pass | Approval Blockers did not show Monthly Rent, Annual Rent, Rent PSF, Lease Type, Base Year, Expense Stop, or CAM Amount as hard blockers. |
| CAM hard blockers | pass | CAM summary showed `0 rule rows` and `ready`; no CAM hard blocker noise. |
| Budget hard blockers | pass | Budget summary showed `Ready`. |
| base-lease optional missing field noise | pass | Base economics appear only in lease summary as blanks, not approval hard blockers. |
| assignment-specific blockers | partial | UI shows `Assignor Name` plus `Tenant Name` source-evidence issue and `Landlord Consent` needs review. |
| original lease advisory | pass | Original lease warning appears as advisory/current-truth context. |
| evidence/source behavior | pass with issues | Tenant row shows source text, but Approval Blockers still flag Tenant Name as lacking valid supporting source text. |
| invalid signature dates | pass | Signature-date problems remain validation drops and were not accepted as visible facts. |
| tab/table behavior | partial | Tabs load and rows render, but `Type` column is still present. |
| action controls | partial/fail | Accept/Edit/Reject icon buttons are visible; action dropdown, Mark Needs Review, Mark N/A, and View Source were not visually present in the tab table. |
| enrichment banner | pass/expected | Banner is visible: `Evidence and CAM enrichment is still running.` |

## Required Review / Approval Blocker Results

Visible summary:

| UI signal | Result |
| --- | --- |
| Reviewed | `1 / 69` |
| Required Reviewed | `0 / 13` |
| Required Pending | `13` |
| Readiness Approval | `1 missing`, `needs review` |
| Budget | `Ready`, `ready` |
| CAM | `0 rule rows`, `ready` |
| Expense Rules | `0 rule rows`, `no rules found` |

Visible Approval Blockers text:

`3 required field(s) must be resolved before approval — Tenant Name (Required field has a value but no valid supporting source text.), Assignor Name (Missing Value), Landlord Consent (Needs Review)`

This confirms base-lease economics/CAM blocker noise is removed in UI, but business/legal should review whether Tenant Name and Landlord Consent should be hard blockers for this assignment document.

## Original Lease Advisory Result

The UI shows:

`Original lease is needed for full CAM, budget, and current-truth analysis. This is advisory and does not create base-lease field blockers.`

This satisfies the Phase 35 expectation that original lease missing is advisory/current-truth context rather than fake base-lease field failures.

## Evidence / Source Text Findings

| Finding | Result |
| --- | --- |
| source-backed row display | present in Parties & Premises tab |
| Tenant Name row | value `NARENDRA PYDI`, status `Needs Review`, confidence `100%`, page `1`, source text shown |
| Tenant Name blocker | still says value has no valid supporting source text |
| invalid signature dates | remain validation drops, not accepted facts |
| low-confidence fields | UI shows `8` low-confidence fields |
| manual required fields | UI shows `10` manual-required fields |

## Action Control Findings

The Parties & Premises tab shows per-row icon buttons with titles:

- Accept
- Edit
- Reject

The requested action dropdown was not found in the tab table, and the following actions were not visually confirmed there:

- Mark Needs Review
- Mark N/A
- View Source

No row action was persisted during verification.

## Enrichment Banner Result

The banner is visible:

`Evidence and CAM enrichment is still running.`

This is acceptable only if the approved uploaded file still has `enrichment_status` pending/running. It should disappear once enrichment is no longer pending/running.

## Screenshots/Notes

Detailed local notes were captured from authenticated DOM inspection. Screenshots were not attached to the repo because the verification environment could not display them safely without exposing local auth state. No secrets, tokens, passwords, MFA codes, or browser storage were included in this report.

Key visible notes:

- Lease Review page reached while authenticated
- Advisory Workflow Blockers show `assignment`
- Advisory copy says assignment/amendment documents are never held to full-lease requirements
- Readiness Summary shows Budget ready and CAM ready
- Approval Blockers contain Tenant Name, Assignor Name, Landlord Consent
- Original lease missing warning is advisory/current-truth context
- Parties & Premises table includes Type, Field / Term, Value, Status, Confidence, Page, Source Text, Actions
- Row controls visible as Accept/Edit/Reject icons

## Remaining Issues

1. Business/legal should confirm whether Tenant Name and Landlord Consent are intended hard blockers for this assignment document.
2. The tab table still includes a `Type` column, which conflicts with the requested no-unexpected-Type-column checklist.
3. Row action controls are icon buttons, not the requested dropdown with Accept/Edit/Mark Needs Review/Mark N/A/Reject/View Source.
4. The enrichment banner remains visible and should be rechecked after enrichment status is no longer pending/running.
5. Source evidence validation still flags Tenant Name despite visible page/source text; this mismatch needs follow-up.

## Recommendation: No Gate

Recommendation remains **No Gate**.

The current UI now avoids false full-base-lease economics/CAM hard blockers for the assignment document, but remaining UI/action/evidence issues should be reviewed before any approval-gating change.

## Recommended Phase 36

Fix the remaining Lease Review UI contract gaps without changing approval behavior: remove or intentionally justify the `Type` column in tab tables, restore/confirm the expected action dropdown options, reconcile Tenant Name source-evidence validation, and business-review the hard-blocker treatment for Tenant Name and Landlord Consent on assignment documents.