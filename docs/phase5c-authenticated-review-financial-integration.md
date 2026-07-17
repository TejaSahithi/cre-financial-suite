# Phase 5C - Authenticated Local Review-to-Financial Integration

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Verdict: PHASE 5C COMPLETE — AUTHENTICATED LOCAL WORKFLOW VALIDATED

## 1. Executive Result

Phase 5C executed the authenticated local review-to-financial workflow against local Supabase over real localhost HTTP/service paths.

The workflow validated:

- Seeded Lease Review retrieval with an authenticated org_admin user.
- Reviewer field-review draft save through `save-lease-review-draft` Edge Function.
- Draft-save retry durability.
- Expense and CAM rule persistence through `save-lease-expense-rule-set` Edge Function.
- Blocked approval state before resolving a required review blocker.
- Successful approval through `approve-lease-workflow` Edge Function.
- Approval idempotency retry using the same idempotency key.
- Budget Preview authority from reviewer-resolved values.
- Durable lease, abstract version, field review, rule, audit, workflow-run, critical-date, and RLS isolation state.

No Azure, Vertex, parser, worker, migration, deployment, remote Supabase, canonical-layout, or provider-default path was touched.

## 2. Local Runtime and Authentication Setup

Preflight:

- Working tree was made clean by committing Phase 5B first: `e76a874 Complete Phase 5B review financial workflow validation`.
- Branch: `feature/document-intelligence-v3`.
- Latest commits: `e76a874`, `652c2b7`, `6b8c900`, `b0c6f2f`, `8987dcd`.
- Local Supabase API: `http://127.0.0.1:54321`.
- Local REST root returned HTTP 200.
- Edge Function gateway endpoint returned HTTP 200 for OPTIONS on required functions.
- Supabase CLI: v2.105.0.
- Stopped local services reported by Supabase CLI: imgproxy and pooler only.

Authentication setup:

- Service-role access was used only for deterministic fixture setup and post-run administrative inspection.
- User actions used signed-in local Supabase users and user JWTs over localhost HTTP.
- The primary user had an `org_admin` membership and explicit page permissions for `LeaseReview`, `Leases`, `LeaseExpenseRules`, and `LeaseExpenseClassification`.
- The cross-org user had a separate organization membership only.

## 3. Seeded Scenario

The integration seeded local-only sanitized records:

- One primary organization.
- One authenticated org_admin user.
- One second organization and second authenticated user for isolation checks.
- One property.
- One tenant.
- One `uploaded_files` source row with `normalized_output`, `ui_review_payload`, `parsed_data`, and `docling_raw` fixture payloads.
- One linked draft lease with `source_file_id` and `document_links` source-file link.
- `extraction_data.fields`, `field_evidence`, `field_reviews`, and `workflow_output.expense_rules`.
- Three expense categories required by local non-null rule FK constraints.
- One existing reviewer-edited monthly-rent field.
- One unresolved required/conflicting field.
- One accepted expense rule.
- One needs-review expense rule.
- One accepted CAM rule.

Sanitized final local identifiers from the successful run:

- Lease prefix: `c814dec2`.
- Org prefix: `1574ab54`.
- Property prefix: `0a9d135d`.
- Final abstract status: `approved`.
- Final abstract version: `1`.

## 4. Actual HTTP/Service Call Sequence

The focused integration test is `scripts/phase5c-authenticated-review-financial-integration.test.js`.

Sequence executed:

1. Service-role setup inserted deterministic local fixture rows.
2. Authenticated user loaded the seeded lease through Supabase REST (`leases.select`).
3. Client-side Lease Review readiness was computed with `normalizeLeaseReviewData` before approval.
4. Authenticated user called `POST /functions/v1/save-lease-review-draft`.
5. Authenticated user retried `POST /functions/v1/save-lease-review-draft` with the same field-review state.
6. Service inspection reloaded durable lease state.
7. Authenticated user called `POST /functions/v1/save-lease-expense-rule-set`.
8. The test confirmed the unresolved required field blocked approval at the product readiness layer and created no version row.
9. Authenticated user resolved the required field and saved the draft again.
10. Authenticated user called `POST /functions/v1/approve-lease-workflow`.
11. Authenticated user retried approval with the same idempotency key.
12. Service inspection reloaded durable downstream state.
13. Cross-org user attempted read/update/approve/read-rule negative checks through RLS/user-auth paths.

## 5. Reviewer Save Result

After draft save and reload:

- Reviewer-edited monthly rent persisted as `13500`.
- Accepted commencement date persisted as `2026-03-01`.
- Optional lease type persisted as `not_applicable`.
- Reviewer note persisted for monthly rent.
- Source evidence remained present in `extraction_data.field_evidence`.
- Stale typed lease column value (`99999`) and stale workflow preview rent (`10000`) did not overwrite reviewer state.
- Draft retry returned HTTP 200 and preserved the same reviewer state.

## 6. Blocked Approval Result

Before resolving `security_deposit`, the product readiness layer identified the unresolved required/conflicting field and did not call the approval Edge Function.

Confirmed:

- Blocker keys included `security_deposit`.
- Optional `lease_type = not_applicable` did not block.
- V3 diagnostics did not create a blocker.
- `lease_abstract_versions` count remained `0` before final approval.

## 7. Successful Approval Result

After resolving `security_deposit`, approval succeeded through `approve-lease-workflow`.

Confirmed durable state:

- `leases.status = approved`.
- `leases.abstract_status = approved`.
- `leases.abstract_version = 1`.
- `leases.abstract_approved_by = Phase 5C Local Reviewer`.
- `leases.abstract_approved_at` was recorded.
- `leases.extraction_data.field_reviews.monthly_rent.value = 13500`.
- `leases.abstract_snapshot.fields.monthly_rent.value = 13500`.
- `leases.abstract_snapshot.fields.security_deposit.value = 32500`.
- Exactly one `lease_abstract_versions` row existed for the approved action.

## 8. Budget Preview Authority Result

Budget Preview authority was validated with `resolveBudgetPreviewInputs` against the reloaded local lease row.

Result:

- `monthly = 13500` from reviewer-edited monthly rent.
- `startBasis = 2026-03-01` from reviewer-resolved commencement date.
- `escalationRate = 3` from reviewer-resolved escalation rate.

The stale workflow preview and typed lease columns did not override reviewed values.

## 9. Expense Rule Persistence Result

After authenticated rule save and approval:

- Exactly one rule set existed for the seeded lease.
- Exactly three rules existed for the seeded lease.
- Accepted real estate tax rule persisted once with `review_status = approved`.
- Uncertain utility rule persisted once with `review_status = needs_review`.
- Source text, confidence, category, and rule keys remained available.
- No duplicate expense rule was created.

## 10. CAM Rule Persistence Result

The accepted CAM reconciliation rule remained identifiable as CAM:

- `expense_category = annual_reconciliation`.
- `cam_eligible = yes`.
- `published_to_cam = true`.
- `review_status = approved`.
- Source clause text persisted.
- Rule key appeared exactly once.

The CAM rule was not duplicated as a second generic expense row.

## 11. Idempotency Result

Safe idempotency actions were repeated:

- Draft save retry: HTTP 200; reviewer state preserved.
- Approval retry with same idempotency key: HTTP 200; same `abstract_version_id` returned.
- Downstream rule reload: one rule set and three rules remained.

Final counts for the successful local run:

- Leases for action: `1`.
- Review draft/current lease row: `1`.
- Approved abstract versions: `1`.
- Expense/CAM rules: `3`.
- Critical dates: `2`, with no retry duplicate.
- Approval workflow runs for idempotency key: `1`.

## 12. Multi-Tenant Isolation Result

A second authenticated user from a different local organization was used for negative checks without service-role access.

Confirmed:

- Cross-org REST read of the seeded lease returned zero rows.
- Cross-org draft save through `save-lease-review-draft` was rejected.
- Cross-org approval through `approve-lease-workflow` was rejected.
- Cross-org REST read of associated expense/CAM rules returned zero rows.

No RLS policy was weakened.

## 13. Audit/Version Result

Confirmed durable audit/version boundary:

- `lease_abstract_versions`: `1` row.
- `lease_field_reviews`: `5` rows.
- `lease_approval_workflow_runs`: `1` row for the approval idempotency key.
- `audit_logs`: `6` rows associated with the local lease.
- Audit actions included `lease_review_draft_saved` and `lease_abstract_approved`.
- Approved snapshot and current lease state matched reviewer-resolved values.

## 14. Confirmed Defects and Fixes

No product implementation defect was reproduced in Phase 5C.

Integration-fixture corrections made while building the local test:

- Local Supabase CLI env names were `ANON_KEY` and `SERVICE_ROLE_KEY`; the test runner maps them to conventional process env names at runtime.
- `uploaded_files.review_status` must use a valid pipeline status; the fixture uses `review_ready`.

No parser, provider, worker, canonical-layout, migration, RLS, or product behavior was changed.

## 15. Files Changed

Added:

- `scripts/phase5c-authenticated-review-financial-integration.test.js`
- `docs/phase5c-authenticated-review-financial-integration.md`

No production implementation code was changed for Phase 5C.

## 16. Test Results

Focused baseline frontend bundle:

- Command: `npx vitest run src/lib/__tests__/phase5bReviewToFinancialWorkflow.test.js src/components/lease-review/__tests__/BudgetPreviewCard.test.jsx src/lib/__tests__/phase5aLeaseReviewContract.test.js src/lib/__tests__/leaseReviewFieldNormalizer.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/__tests__/leaseReviewExpenseRuleRows.test.jsx src/services/__tests__/leaseExpenseRuleService.test.js src/services/__tests__/leaseExpenseRuleWorkflowService.test.js src/services/utils/leaseExpenseRuleTaxonomy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js`
- Result: 10 files passed / 116 tests passed.

Authenticated local integration workflow:

- Command: `npx vitest run scripts/phase5c-authenticated-review-financial-integration.test.js`
- Result: 1 file passed / 1 test passed.

Backend provider-neutral bundle:

- Command: `docker run --rm -v "${PWD}:/workspace" -w /workspace denoland/deno:2.7.12 deno test --allow-env --allow-read --allow-net --no-lock supabase/functions/_tests/approve-lease-workflow.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts supabase/functions/_tests/lease-review-readiness-and-evidence-guarantees.test.ts supabase/functions/_tests/lease-expense-rule-review-workflow.test.ts supabase/functions/_tests/lease-expense-rule-cam-publish-workflow.test.ts supabase/functions/_tests/diagnostics-readiness-layout-ownership.test.ts`
- Result: ok | 39 passed | 0 failed.

Full frontend regression:

- Command: `npm test`.
- Result: 59 files passed / 671 tests passed.

Static/build checks:

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS. Existing Vite chunk/dynamic-import warnings remain.

## 17. Remaining Risks

This phase did not perform browser visual validation. It used authenticated local HTTP/service paths and database reloads.

This phase did not run upload parsing, Azure, Vertex, Docling, normalize providers, workers, migrations, deployment, or remote Supabase.

The focused integration test requires local Supabase to be running and requires local Supabase keys to be supplied at runtime; it is intentionally outside the default `npm test` glob.

Local fixture rows remain in the local development database as sanitized Phase 5C evidence.

## 18. Next Recommendation

Commit Phase 5C after final diff/secret hygiene checks.

Do not start Phase 5D automatically. Any later phase should explicitly decide whether it needs browser observation, live-provider validation, or deployment-specific verification.