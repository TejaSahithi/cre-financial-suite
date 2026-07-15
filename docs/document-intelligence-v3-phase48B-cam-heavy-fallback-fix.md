# Document Intelligence v3 Phase 48B: CAM-Heavy Fallback Fix

Generated: 2026-07-15

## Executive Summary

Phase 48B implemented narrow **no-provider Lease Review fallback/projection fixes** for the CAM-heavy Craven Wings base lease gaps diagnosed in Phase 48A.

No deployment, remote read/write, provider call, parse rerun, extraction rerun, service-key access, approval-gating change, or global v3 provider change occurred.

Recommendation remains: **No Gate**.

## Candidate

| Item | Value |
| --- | --- |
| uploaded_file_id | 0155251a-b911-408c-ae83-469d8d6eb534 |
| file | Craven Wings Lease Executed 1.pdf |
| document_subtype | base_lease |
| test type | uploaded-file-only structured payload validation |
| reliable leases row used | no |

## Files Changed

| File | Change |
| --- | --- |
| src/lib/leaseReviewFieldNormalizer.js | Added no-provider docling_raw fallback projection for premises address, security deposit, rent schedule rows, CAM estimate, pro-rata taxes/insurance/CAM, and admin fee rule rows. |
| src/lib/__tests__/leaseReviewFieldNormalizer.test.js | Added focused Phase 48B regression coverage. |
| docs/document-intelligence-v3-phase48B-cam-heavy-fallback-fix.md | This report. |
| docs/document-intelligence-v3-batch-audit-qa.md | Phase 48B QA rollup. |
| docs/document-intelligence-v3-batch-audit-qa.json | Phase 48B structured QA rollup. |

## Implementation Summary

The fix stays in the existing Lease Review normalizer layer. It does not rewrite backend extraction and does not call any provider.

Implemented fallbacks:

- Stronger premises address fallback from stored docling_raw page text when extracted property_address appears to be a tenant/contact address.
- Security Deposit Addendum total fallback into the standard security_deposit field, marked needs_review when multiple source amounts exist.
- CAM estimate fallback as a non-editable CAM rule row with source page/text.
- Rent Addendum schedule fallback as non-editable Rent & Charges dynamic schedule rows, without flattening the schedule into monthly_rent.
- Pro-rata taxes, insurance, and CAM fallback rows from stored source text.
- Admin/management fee fallback row from existing admin_fee_pct evidence.
- Dedupe so fallback CAM/expense rows do not duplicate already-structured rule rows.

Clause Records were intentionally not forced. CAM/expense facts go to CAM/expense rows, not generic clause rows.

## Craven Before / After

| Area | Before Phase 48B | After Phase 48B |
| --- | --- | --- |
| property_address | 3826 MAUpin DR, tenant/contact-style address | 12350 South Northshore, Knoxville, TN 37922 from premises text, status needs_review |
| security_deposit | missing | 15535.36 from Security Deposit Addendum, status needs_review |
| CAM estimate | missing | CAM rule: $5.25 per leasable square foot, source page 14 |
| expense rules | 0 | 2 fallback rows: real estate taxes, insurance premiums |
| CAM rules | 0 | 3 fallback rows: CAM estimate, pro-rata CAM, admin/management fee |
| rent schedule | 0 | Rent Addendum schedule rows for month ranges, source page 14 |
| monthly_rent scalar | missing | still missing; schedule is not misleadingly flattened |
| clause records | 0 | still 0 by design; no noisy generic clauses added |

## Regression Results

| Check | Result |
| --- | --- |
| approved assignment document | passed; profile remains assignment, budget/CAM blockers remain empty |
| Phase 45 base lease | passed; base_lease profile preserved and Phase 46 premises_address alias behavior remains stable |
| Craven CAM-heavy base lease | passed; property/CAM/rent/security improvements visible from uploaded-file-only payload |
| duplicate structured rule protection | passed; fallback does not duplicate a structured CAM estimate rule |

## Tests Added

Added focused tests covering:

1. Tenant/contact address does not satisfy property_address when stronger premises evidence exists.
2. Premises address fallback prefers premises/demised-premises text.
3. CAM estimate and expense recovery fallback rows are generated with evidence.
4. Rent Addendum schedule rows are generated without flattening to monthly_rent.
5. Security Deposit Addendum total projects with evidence.
6. Existing assignment behavior remains unchanged.
7. Phase 46 base-lease alias behavior remains unchanged.
8. Duplicate fallback CAM/expense rows are not generated when structured rows already exist.

## Remaining Known Gaps

- monthly_rent remains missing for Craven because the rent addendum is a schedule, not one scalar rent value.
- square_footage, commencement_date, expiration_date, and lease_type were not in Phase 48B scope.
- Clause Records remain conservative; no generic clause fallback was added.
- Evidence/page completeness can still be improved for fields outside the narrow fallback set.
- Approval gating logic was not changed; this remains advisory/projection hardening.

## Verification

Focused verification completed:

- npm run test -- src/lib/__tests__/leaseReviewFieldNormalizer.test.js
- npm run test -- src/lib/__tests__/leaseReviewFieldNormalizer.test.js src/lib/__tests__/leaseReviewSchema.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js
- temporary runtime export verification passed against Craven, Phase 45 base lease, and the approved assignment export; temporary test file deleted.

Full verification commands are tracked in the final Phase 48B report response.

## Recommendation

**No Gate.**

Phase 48B improves review visibility for stored no-provider source artifacts, but the system should remain advisory-only until broader extraction/evidence coverage is reviewed across more documents.
