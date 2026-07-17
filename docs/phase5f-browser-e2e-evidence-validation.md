# Phase 5F Security Deposit Projection Closure

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Verdict: PHASE 5F SECURITY DEPOSIT PROJECTION DEFECT CLOSED

## Scope

This update closes only the Phase 5F Security Deposit projection defect. It does not close Linux Deno backend recovery; that remains a deferred pre-staging verification item.

No approval behavior, persistence behavior, provider code, database schema, package-current-truth policy, or unrelated UI was changed. No Azure, Vertex, Docling, parser, worker, deployment, remote Supabase, or migration work was performed.

## Reproduction

The existing Phase 5F fixture reproduced the mismatch:

- Extracted `security_deposit` was stale at `30000` in `leases.extraction_data.fields.security_deposit`.
- Reviewer edited Security Deposit to `32500`.
- Save succeeded.
- Persistence was correct:
  - `leases.security_deposit = 32500`
  - `leases.extraction_data.field_reviews.security_deposit.value = 32500`
- Before the fix, after browser reload the Rent & Charges standard row could display the stale extracted value because standard-field normalization read extracted/canonical resolver output before reviewer state and before the typed reviewed lease column.

Authority path traced:

- `leases.extraction_data.field_reviews.security_deposit`
- `leases.security_deposit`
- extracted `security_deposit` in `leases.extraction_data.fields`
- `normalizeLeaseReviewData()`
- `normalizeStandardFields()` fixed-field row generation
- dynamic-field suppression for canonical fields
- `LeaseReviewTabTable` row rendering

`LeaseReviewTabTable` was not the defect source; it rendered the normalized row value it received. Dynamic-field suppression was also correct; no duplicate Security Deposit dynamic row was created.

## Fix

The generic Lease Review display authority now lives in `src/lib/leaseReviewFieldNormalizer.js` and resolves standard-field row value as:

1. reviewer-resolved field-review value
2. typed reviewed lease column
3. extracted value as fallback

Implementation notes:

- `normalizeLeaseReviewData()` defaults to `lease.extraction_data.field_reviews` when a separate `fieldReviews` map is not passed.
- `normalizeStandardFields()` uses the effective field review map for fixed-field row generation.
- `readResolvedReviewValue()` returns values only from resolved review statuses.
- `readTypedLeaseColumnValue()` checks typed lease column aliases before extracted fallback.
- Reviewer source evidence is merged when present; otherwise existing source evidence remains attached.
- No Security Deposit-only special case was introduced.

## Regression Coverage

Focused normalizer coverage proves:

- extracted Security Deposit remains stale at `30000`
- reviewer value is `32500`
- typed lease column value is `32500`
- rendered normalized row resolves to `32500`
- evidence remains attached
- Rent & Charges contains one Security Deposit row
- dynamic findings do not duplicate Security Deposit
- typed lease column wins over extracted fallback when no reviewer map is present

Phase 5F Playwright now asserts after browser reload at both viewports:

- Security Deposit row visibly displays `32500`
- stale `30000` is not shown as the current row value
- opening edit shows current editable value `32500`
- approval still succeeds and persisted approved state remains correct

## Verification Results

- Focused projection tests: `npx vitest run src/lib/__tests__/leaseReviewFieldNormalizer.test.js` - 1 file passed, 70 tests passed, 0 failed.
- Phase 5F Playwright desktop: `npm run test:e2e:phase5f -- --project=phase5f-desktop` - 1 test passed, 0 failed.
- Phase 5F Playwright laptop: `npm run test:e2e:phase5f -- --project=phase5f-laptop` - 1 test passed, 0 failed.
- Lint: `npm run lint` - passed, exit code 0.
- Typecheck: `npm run typecheck` - passed, exit code 0.
- Build: `npm run build` - passed, exit code 0. Vite emitted pre-existing chunking/dynamic-import warnings only.
- Diff whitespace check: `git diff --check` - passed, exit code 0.

## Deferred

Linux Deno backend recovery remains a deferred pre-staging verification item and is intentionally not claimed by this report.
