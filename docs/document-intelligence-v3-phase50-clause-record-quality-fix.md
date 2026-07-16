# Enterprise Document Intelligence v3 - Phase 50 Clause Record Quality Fix

Date: 2026-07-15

Recommendation: **No Gate**

## Executive Summary

Phase 50 fixed the Clause Records noise regression found in Phase 49. The regression came from `computeFallbackClauseRows` unioning extracted `lease_fields` and document-item payloads into Clause Records even when those facts were already projected into standard fields, Expense/CAM rules, Rent Addendum rows, or Security Deposit rows.

The fix adds a narrow profile-aware Clause Records quality filter in `leaseReviewFieldNormalizer.js`. For base leases, Clause Records now keep distinct, evidence-backed legal summaries and filter duplicate field/rule echoes. Assignment behavior remains unchanged to preserve Phase 44A-Fix behavior.

No deployment, remote read/write, provider call, parse rerun, extraction rerun, or approval-gating change occurred.

## Root Cause

The 34 Craven Clause Records came from payload-derived field/document-item union paths, especially:

- `workflow_output.lease_fields`
- `extraction_data.fields`
- extracted document items collected through `collectExtractedDocumentItems`
- generic fallback rows routed to `clause_records`

Most rows were not true clause summaries. They were duplicate evidence snippets for standard fields or facts that now belong in dedicated tabs.

## Before / After Counts

| Document | Before | After | Result |
| --- | ---: | ---: | --- |
| Approved assignment | 18 | 18 | unchanged, acceptable assignment behavior preserved |
| Phase 45 base lease | 27 | 3 | noisy field echoes filtered; legal summaries retained |
| Craven CAM-heavy base lease | 34 | 3 | regression fixed; low defensible Clause Records count |

## Filtered Examples

| Group | Example | Correct Handling |
| --- | --- | --- |
| duplicate standard field | Craven `Tenant Name`, `Landlord Name`, `Property Address`, `Lease Date` | standard field rows only |
| duplicate Expense/CAM rule | Craven tax responsibility, insurance responsibility, admin fee, CAM responsibility | Expenses / Recoveries or CAM Rules rows only |
| duplicate rent schedule | Rent Addendum/monthly rent snippets | Rent & Charges schedule rows only |
| duplicate security deposit | Security Deposit Addendum amount snippets | Security Deposit standard field only |
| generic/low-value boilerplate | short generic legal phrases without distinct business meaning | filtered |

## Retained Examples

| Document | Retained Clause | Reason |
| --- | --- | --- |
| Phase 45 base lease | Assumption Scope | distinct assignment/transfer legal summary |
| Phase 45 base lease | Landlord Consent | distinct assignment/subletting consent summary |
| Phase 45 base lease | Default Cure Period | distinct default/remedies legal summary |
| Craven base lease | Landlord Consent | distinct assignment/subletting restriction summary |
| Craven base lease | Default Cure Period | distinct default/remedies legal summary |
| Craven base lease | Renewal Notice Months | distinct renewal option notice summary |

Retained base-lease Clause Records are marked `needs_review`.

## Regression Results

### Approved Assignment

- Profile: `assignment`
- Clause Records: 18 before, 18 after
- Hard blocker remains `assignor_name`
- No base-lease blocker weakening
- Assignment Clause Records behavior preserved

### Phase 45 Base Lease

- Profile: `base_lease`
- Clause Records: 27 before, 3 after
- Phase 46 alias fix still holds
- Approval blockers remain: `lease_date`, `commencement_date`, `expiration_date`, `lease_term`
- No noisy Phase 48B fallback rows created

### Craven CAM-Heavy Base Lease

- Profile: `base_lease`
- Clause Records: 34 before, 3 after
- Expense rules remain: 2
- CAM rules remain: 3
- Rent Addendum rows remain: 8
- Property address fallback remains: `12350 South Northshore, Knoxville, TN 37922`
- Security deposit fallback remains: `$15,535.36`
- Approval blockers remain: `lease_type`, `square_footage`, `commencement_date`, `expiration_date`, `monthly_rent`, `premises_use`

## Files Changed

- `src/lib/leaseReviewFieldNormalizer.js`
- `src/lib/__tests__/leaseReviewFieldNormalizer.test.js`
- `docs/document-intelligence-v3-phase50-clause-record-quality-fix.md`
- `docs/document-intelligence-v3-batch-audit-qa.md`
- `docs/document-intelligence-v3-batch-audit-qa.json`

## Tests Added

Focused Phase 50 tests cover:

1. Clause Records do not duplicate standard fields.
2. Clause Records do not duplicate Expense/CAM rule rows.
3. Clause Records do not duplicate Rent Addendum schedule rows.
4. Clause Records do not duplicate Security Deposit fallback rows.
5. Generic legal boilerplate is filtered.
6. Distinct high-value legal summaries are retained.
7. Assignment behavior remains unchanged.
8. Craven CAM/rent/security fallback rows remain present.

## Remaining Gaps

- Craven still lacks scalar `monthly_rent`, `square_footage`, `commencement_date`, `expiration_date`, `lease_type`, and `premises_use`.
- Evidence/page completeness remains future work.
- Clause Records are still payload-derived diagnostics, not a durable v3 claim/evidence ledger.

## Recommendation

**No Gate.**

Recommended Phase 51: continue no-provider QA with one more real base lease or run a narrow evidence/page-completeness phase for retained fallback rows, without approval behavior changes.
