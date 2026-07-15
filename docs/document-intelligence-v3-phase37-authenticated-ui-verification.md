# Document Intelligence v3 Phase 37 Authenticated UI Verification

Generated: 2026-07-15

## 1. Executive Summary

Phase 37 established an authenticated local-only session and reached the approved Lease Review screen:

`http://127.0.0.1:5173/LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2`

The Phase 36 UI contract was visually verified after one clear regression was found and fixed. The advisory blocker panel was still deriving missing fields from the raw field contract in one path, which caused assignment advisory fields to appear as profile-required fields. That path now uses the current-review profile policy.

Recommendation remains: **No Gate**.

## 2. Authenticated Local Session Method

A fresh local-only Supabase test user/session was created against `http://127.0.0.1:54321` using the local anon configuration already used by the frontend. Local MFA was completed without printing passwords, tokens, secrets, or auth storage. A local profile and org membership were created only in the local database so the app could route past onboarding and open the approved Lease Review screen.

Forbidden items were not used:

- No production credentials.
- No service-role key.
- No `SUPABASE_ACCESS_TOKEN`.
- No secret values printed.
- No hosted Supabase endpoint.

## 3. Local Environment Verified

| Check | Result |
| --- | --- |
| local app URL | `http://127.0.0.1:5173` |
| frontend Supabase URL | `http://127.0.0.1:54321` |
| local DB endpoint | `127.0.0.1:54322` |
| hosted Supabase endpoint used | no |
| production write endpoint used | no |
| Azure call | no |
| Vertex/Gemini call | no |
| parse/extraction rerun | no |
| deploy | no |

## 4. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## 5. Type Column Verification

Authenticated visual verification confirmed the tab table headers are:

| Header |
| --- |
| Field / Term |
| Value |
| Status |
| Confidence |
| Page |
| Source Text |
| Action |

The visible `Type` column is removed from the standard Lease Review business table.

## 6. Action Dropdown Verification

Action dropdown buttons were visible on tab rows. The verified menu for a row contained:

| Action |
| --- |
| Accept |
| Edit |
| Mark Needs Review |
| Mark N/A |
| Reject |
| View Source |

Icon-only Accept/Edit/Reject controls are no longer the primary row action model.

## 7. Assignment Blocker Verification

The authenticated UI initially exposed a Phase 37 regression: the advisory blocker normalization still used `LEASE_FIELD_CONTRACT.requiredByDocumentProfile` directly, so assignment advisory fields could leak into the profile-required list.

Fix applied:

- `normalizeApprovalBlockers` now receives and uses `currentReviewPolicy`.
- Assignment missing-field blockers use `currentReviewPolicy.requiredFieldKeys`.
- Budget/CAM blockers are suppressed when `applyBaseLeaseBlockers` is false.
- Policy advisory gaps remain warnings, not hard blockers.

Post-fix visual verification of the required profile section showed:

| Field | Result |
| --- | --- |
| Assignor Name | remains required hard blocker |
| Tenant Name | advisory warning only, not profile-required |
| Landlord Consent | advisory warning only, not profile-required |
| Landlord Consent For Transfer | not profile-required |
| base lease economics | not shown as blockers |
| CAM blockers | not shown as blockers |
| Budget blockers | not shown as blockers |

## 8. Original Lease Advisory Verification

The original lease gap remains visible as an advisory/current-truth gap:

`Original lease is needed for full CAM, budget, and current-truth analysis. This is advisory and does not create base-lease field blockers.`

It does not create fake base-lease field failures for the assignment document.

## 9. Evidence / Source Text Findings

The authenticated table includes `Page` and `Source Text` columns. Source-backed rows can show page/source text where available.

Known diagnostic evidence limitations remain:

- `tenant_name` remains advisory/needs-review when evidence is weak or source-less.
- Invalid signature dates remain validation drops or unaccepted facts from the diagnostic path.
- The reconstructed local evidence set remains advisory and is not a v3 hard gate.

## 10. Enrichment Banner Verification

The approved local screen showed the enrichment banner because the local enrichment status is in-flight. Source logic remains centralized so the banner appears only for `pending` or `running`. Completed, failed, null, and undefined states remain covered by focused UI state tests rather than this single visual fixture.

## 11. Screenshots or Notes

Detailed local verification notes were captured without secrets in `C:\tmp\phase37-ui-result.json`.

Captured facts:

- authenticated Lease Review reached: yes
- console errors: 0
- Type column visible: no
- action dropdown verified: yes
- menu items: Accept, Edit, Mark Needs Review, Mark N/A, Reject, View Source
- required profile section: Assignor Name only
- warnings: original lease, Tenant Name advisory, Landlord Consent advisory
- original lease advisory visible: yes
- enrichment banner visible for current in-flight status: yes

## 12. Remaining Issues

- No production visual verification was performed; this was local-only.
- Enrichment banner hidden states were not visually exercised in this single fixture, but are covered by focused tests.
- v3 evidence remains advisory-only; provider-backed fact-ledger behavior still requires scoped provider configuration and explicit approval.


## 13. Verification

| Check | Result |
| --- | --- |
| QA JSON parse check | passed |
| focused Lease Review tests | passed, 3 files / 12 tests |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed with existing Vite warnings |
| `npm run test` | passed, 55 files / 590 tests |

Initial Vitest attempts hit the known Windows sandbox `spawn EPERM` startup issue before tests executed. The focused and full suites passed after rerunning with local execution permission.

## 14. Recommendation: No Gate

Recommendation remains: **No Gate**.

The UI contract is now locally verified for the approved assignment screen, but v3 advisory diagnostics are still not approval gates and provider-backed evidence remains unavailable.

## 15. Recommended Phase 38

Phase 38 should be business/legal review of the verified assignment Lease Review behavior. Confirm that Assignor remains the correct hard blocker, Tenant Name and Landlord Consent are correctly advisory for this assignment profile, and the original lease gap should stay advisory/current-truth rather than approval-blocking.
