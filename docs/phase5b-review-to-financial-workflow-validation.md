# Phase 5B - Lease Review Decisions to Financial Workflow Validation

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Verdict: PHASE 5B COMPLETE — DOWNSTREAM WORKFLOW VALIDATED

## 1. Executive Result

Phase 5B validated the local downstream contract from Lease Review reviewer decisions into financial workflow surfaces: persisted lease review state, Lease Expense Rules, CAM Rules, Budget Preview inputs, approval readiness, and audit/version-preservation boundaries.

Two local contract defects were found and fixed:

- Budget Preview used stale workflow/typed lease values ahead of reviewer-edited field review decisions.
- Stored amendment metadata with carried-forward lease values could inherit base-lease approval blockers.

No parser, provider, worker, migration, deployment, remote Supabase, Azure, or Vertex behavior was changed.

## 2. Current Downstream Architecture

Lease Review normalizes lease state through `normalizeLeaseReviewData`, then partitions standard fields, dynamic findings, expense rules, CAM rules, clauses, critical dates, current review policy, and approval blockers for UI consumption.

Reviewer field decisions are held in `extraction_data.field_reviews`, saved through `saveAbstractDraft`, and sent to approval through `approveLeaseWorkflow`. Approval builds a snapshot/version boundary and then triggers lease expense-rule generation without forcing parser/provider re-extraction.

Expense and CAM rows flow from persisted rule sets first, then from `workflow_output.expense_rules` only as a fallback when no persisted rows exist.

## 3. Authority and Source-of-Truth Matrix

Reviewer field decisions: `leases.extraction_data.field_reviews` is the review authority for accepted, edited, N/A, manual-required, and legal-review statuses.

Approved abstract: approval writes an abstract snapshot and increments abstract version through the approval workflow contract.

Expense Rules and CAM Rules: persisted `lease_expense_rules` rows are authoritative once present; `workflow_output.expense_rules` is a fallback seed only.

Budget Preview: reviewer-resolved budget inputs now take precedence over workflow preview and typed lease columns.

V3 diagnostics: advisory only / No Gate. V3 evidence and readiness diagnostics do not gate approval.

## 4. Reviewer Persistence Findings

`LeaseReview.jsx` hydrates reviewer state from `lease.extraction_data.field_reviews`, updates it through quick actions and save flows, and invalidates lease queries after approval.

`saveAbstractDraft` calls the server draft workflow and mirrors reviewer state into the durable lease review state. Existing backend tests confirm reviewer state preservation during draft rebuilds.

Automated refresh preservation is covered by `mergeLatestExtraction`: reviewer-approved or edited fields are protected from stale automated extraction replacement.

## 5. Expense Rules Findings

`leaseExpenseRuleService.loadRuleSet` reads persisted rows first and only includes workflow fallback when no persisted rules exist.

`persistExpenseRulesFromWorkflow` seeds draft rules from workflow output while preserving protected human decisions.

Phase 5B tests validate accepted and needs-review expense decisions are projected from the same normalized contract that feeds Lease Review.

## 6. CAM Rules Findings

CAM rows are split from the same workflow/persisted rule contract through the taxonomy partitioner.

Phase 5B tests validate CAM reconciliation and true-up rows remain separate from general expense rows and preserve review status.

Backend provider-neutral CAM publish tests validate server-side CAM publish payload and blocker behavior.

## 7. Budget Preview Findings

Confirmed defect: `BudgetPreviewCard` previously selected workflow preview rent or typed lease columns before reviewer-edited/accepted field-review values.

Fix: `BudgetPreviewCard` now delegates input selection to `resolveBudgetPreviewInputs`, which reads reviewer-resolved monthly rent, rent commencement / commencement date, and escalation rate before stale workflow or typed fallback values.

The helper skips missing numeric candidates instead of coercing `null` to zero, and it does not use N/A reviewer values as financial assumptions.

## 8. Approval Readiness Findings

Base leases retain existing required-field blockers.

Assignment/amendment-style documents use reduced current-review policy and do not inherit full base-lease budget/CAM blockers.

Unknown CRE documents remain advisory and do not silently become base leases.

## 9. Approval Persistence Findings

Backend approval tests confirm payload validation, abstract snapshot grouping, and idempotent critical-date row derivation.

Reviewer state preservation tests confirm draft rebuilds preserve existing `field_reviews` exactly and deterministically.

No approval runtime call was made in this phase; validation stayed at provider-neutral unit/contract level.

## 10. Idempotency Findings

Backend tests covered idempotent critical-date derivation and deterministic reviewer-state preservation.

Expense-rule service tests covered workflow fallback, protected decision preservation, and rule-set save/update behavior.

CAM publish and review workflow backend tests covered idempotency-key validation boundaries.

## 11. Amendment and Assignment Findings

Confirmed defect: a stored `document_subtype: "amendment"` with carried-forward lease values could be inferred as a base lease because full-lease signals were checked before stored profile metadata.

Fix: `resolveCurrentReviewProfile` now honors stored top-level profile metadata before falling back to inferred extractor profile detection.

The older full-lease safety guard remains intact for AI/workflow-stamped assignment labels when strong full-lease signals indicate the document is actually a base lease.

## 12. Confirmed Defects

Fixed:

- Budget Preview authority order ignored reviewer-edited budget inputs.
- Amendment profile requiredness could inherit base-lease blockers when top-level stored subtype existed alongside carried-forward lease values.

No remaining Phase 5B downstream contract defects are known from the local contract evidence.

## 13. Files Changed

Implementation:

- `src/components/lease-review/BudgetPreviewCard.jsx`
- `src/components/lease-review/utils/budgetPreviewInputs.js`
- `src/lib/leaseReviewCurrentPolicy.js`

Tests:

- `src/components/lease-review/__tests__/BudgetPreviewCard.test.jsx`
- `src/lib/__tests__/leaseReviewCurrentPolicy.test.js`
- `src/lib/__tests__/phase5bReviewToFinancialWorkflow.test.js`

Report:

- `docs/phase5b-review-to-financial-workflow-validation.md`

## 14. Test Results

Preflight:

- `git status --short`: clean before Phase 5B edits after Phase 5A visual-closure report commit.
- Branch: `feature/document-intelligence-v3`.
- Recent commits included `652c2b7 Document Phase 5A visual closure handoff` and `6b8c900 Complete Phase 5A Lease Review contract validation`.
- Local Supabase status: local stack available at `http://127.0.0.1:54321`; no remote Supabase used.

Baseline focused frontend:

- Initial sandbox run failed before tests with Windows `spawn EPERM` while Vite/esbuild loaded config.
- Escalated rerun command: `npx vitest run src/lib/__tests__/phase5aLeaseReviewContract.test.js src/lib/__tests__/leaseReviewFieldNormalizer.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/__tests__/leaseReviewExpenseRuleRows.test.jsx src/services/__tests__/leaseExpenseRuleService.test.js src/services/__tests__/leaseExpenseRuleWorkflowService.test.js src/services/utils/leaseExpenseRuleTaxonomy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js`
- Result: 8 files passed / 108 tests passed.

Baseline backend provider-neutral bundle:

- Command: `docker run --rm -v "${PWD}:/workspace" -w /workspace denoland/deno:2.7.12 deno test --allow-env --allow-read --allow-net --no-lock supabase/functions/_tests/approve-lease-workflow.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts supabase/functions/_tests/lease-review-readiness-and-evidence-guarantees.test.ts supabase/functions/_tests/lease-expense-rule-review-workflow.test.ts supabase/functions/_tests/lease-expense-rule-cam-publish-workflow.test.ts supabase/functions/_tests/diagnostics-readiness-layout-ownership.test.ts`
- Result: ok | 39 passed | 0 failed.

Focused Phase 5B frontend contract bundle:

- Command: `npx vitest run src/lib/__tests__/phase5bReviewToFinancialWorkflow.test.js src/components/lease-review/__tests__/BudgetPreviewCard.test.jsx src/lib/__tests__/phase5aLeaseReviewContract.test.js src/lib/__tests__/leaseReviewFieldNormalizer.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/__tests__/leaseReviewExpenseRuleRows.test.jsx src/services/__tests__/leaseExpenseRuleService.test.js src/services/__tests__/leaseExpenseRuleWorkflowService.test.js src/services/utils/leaseExpenseRuleTaxonomy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js`
- Final result after fixes: 10 files passed / 116 tests passed.

Post-change backend provider-neutral bundle:

- Command: same Docker Deno 2.7.12 backend bundle above.
- Result: ok | 39 passed | 0 failed.

Full frontend regression:

- Initial sandbox run failed before tests with Windows `spawn EPERM` while Vite/esbuild loaded config.
- Escalated rerun command: `npm test`.
- Result: 59 files passed / 671 tests passed.

Static/build checks:

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS. Existing Vite chunk/dynamic-import warnings remain; no build failure.

## 15. Remaining Risks and Conditions

This phase did not perform a browser/manual walkthrough, live upload, live provider call, deployment, migration, remote Supabase query, or Phase 5C workflow.

The backend suite was the provider-neutral contract bundle, not a full live local Edge Function exercise.

Docker Deno fetched public module cache dependencies during the backend run. No Azure, Vertex, or remote Supabase endpoint was invoked by the tested code paths.

The final verdict is local implementation validation only; deployment/activation remains outside Phase 5B.

## 16. Next Recommendation

Proceed to the next approved local phase only after committing Phase 5B. Do not start Phase 5C from this report alone.

Before any deployment or activation, run the appropriate deployment-specific regression, confirm environment alignment, and keep V3 diagnostics advisory / No Gate unless an explicit later phase changes that policy.