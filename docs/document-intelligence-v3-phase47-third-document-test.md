# Document Intelligence v3 Phase 47: Third Document Lease Review QA

Generated: 2026-07-15

## Executive Summary

Phase 47 ran uploaded-file-only Lease Review QA against the real CAM/expense-heavy base lease candidate, **Craven Wings Lease Executed 1.pdf**.

This phase did **not** use a leases row because no reliable matching lease row exists. The test fixture wrapped only the approved uploaded_files export in the same upload-backed shape consumed by the existing Lease Review normalizer.

Recommendation remains: **No Gate**.

## Scope And Constraints

| Constraint | Result |
| --- | --- |
| deploy | no |
| remote write/read | no |
| broad production scan | no |
| service keys/secrets touched | no |
| Azure/Vertex/Gemini/OpenAI/provider call | no |
| parse/extraction rerun | no |
| source code changed | no |
| temporary test fixture deleted | yes |
| reliable leases row used | no |

## Candidate Validation

| Item | Result |
| --- | --- |
| uploaded_file_id | 0155251a-b911-408c-ae83-469d8d6eb534 |
| org_id | 1307dd95-e7c5-4e08-833e-749444e8f4c8 |
| file_name | Craven Wings Lease Executed 1.pdf |
| status / processing_status | review_required / review_required |
| review_status | pending |
| document_subtype | base_lease |
| not approved assignment doc | yes |
| not Phase 45 base lease | yes |
| synthetic/stub data | no |

Available source artifacts:

| Artifact | Result |
| --- | --- |
| docling_raw | present |
| docling pages | 26 |
| normalized_output | present |
| ui_review_payload | present |
| parsed_data | present |
| valid_data rows | 1 |

Pipeline evidence:

| Stage | Result |
| --- | --- |
| parse completed | yes |
| normalize completed | yes |
| parse page count | 26 |
| parse full_text_chars | 98439 |
| normalize full_text_chars | 79730 |
| enrichment status | failed due to compute resources |
| enrichment error | Function failed due to not having enough compute resources (please check logs) |

## Document Sanity Checks

| Expected fact | Found in source or normalized output |
| --- | --- |
| Landlord: Markets at Choto, LLC | yes, extracted as MARKETS AT CHOTO, LLC |
| Tenant: Cress Family Restaurants, LLC | yes, extracted as CRESS FAMILY RESTAURANTS, LLC |
| Building 9, Suites 3 and 4 | yes, unit extracted as 3 and 4 |
| 12350 South Northshore / The Markets at Choto | source text contains it; normalized property address is wrong |
| Lease date: September 8, 2020 | yes, extracted as 2020-09-08 |
| Lease term: 86 months | yes, extracted as 86 |
| CAM estimate: $5.25 per leasable square foot | source text contains it; cam_amount is missing |
| Admin fee: 5% | extracted as 5, but evidence is not marked verified |
| Tenant pays pro-rata taxes/insurance/CAM | yes, tax/insurance responsibility fields are source-backed |
| Security deposit addendum exists | source text contains it; security_deposit field is missing |
| Rent addendum exists | source text contains it; rent fields are missing |

## Normalizer Method

Executed the real production normalizeLeaseReviewData() against this fixture shape:

- minimal uploaded-file-only lease wrapper
- uploaded_files = uploaded_files_0155251a.json row
- uploaded_file = uploaded_files_0155251a.json row
- no unrelated leases row
- no code changes
- temporary Vitest file deleted after use

Targeted test result: **passed, 1 file / 1 test**.

## Profile And Policy

| Check | Result |
| --- | --- |
| resolved profile | base_lease |
| current policy profile | base_lease |
| policy | base_lease |
| apply base lease blockers | yes |
| assignment-specific downgrades applied | no |
| advisory gap keys | none |

Required field keys:

- 'tenant_name'
- 'landlord_name'
- 'premises_address'
- 'square_footage'
- 'premises_use'
- 'lease_date'
- 'lease_term'
- 'commencement_date'
- 'expiration_date'
- 'monthly_rent'
- 'security_deposit'
- 'lease_type'

## Standard Field Counts

| Metric | Count |
| --- | ---: |
| standard fields | 88 |
| populated standard fields | 32 |
| source-backed standard fields | 31 |
| needs-review standard fields | 6 |
| missing standard fields | 56 |
| dynamic findings | 0 |
| expense rules | 0 |
| CAM rules | 0 |
| clause records | 0 |
| critical dates | 7 |
| budget preview rows | 7 |

## Approval Blockers And Readiness

| Area | Result |
| --- | --- |
| approval readiness | needs_review |
| budget readiness | blocked |
| CAM readiness | needs_review |
| expense rules readiness | no_rules_found |
| budget missing inputs count | 9 |

Approval missing fields:

- 'lease_type'
- 'square_footage'
- 'commencement_date'
- 'expiration_date'
- 'monthly_rent'
- 'security_deposit'
- 'premises_use'

Budget blockers:

- 'lease_type'
- 'square_footage'
- 'start_date'
- 'end_date'
- 'commencement_date'
- 'expiration_date'
- 'monthly_rent'
- 'annual_rent'
- 'rent_per_sf'

CAM blockers:

- 'lease_type'
- 'square_footage'
- 'start_date'
- 'end_date'
- 'commencement_date'
- 'expiration_date'
- 'base_year'
- 'expense_stop'
- 'cam_amount'
- 'cam_cap_type'
- 'cam_cap_pct'
- 'gross_up_enabled'
- 'gross_up_threshold'
- 'building_rsf'

Needs-review fields:

- 'landlord_signatory_name'
- 'property_address'
- 'billing_frequency'
- 'admin_fee_pct'
- 'management_fee_basis'
- 'renewal_notice_months'

## Phase 46 Alias Fix Check

| Alias case | Result |
| --- | --- |
| premises_address via property_address | cleared; premises_address is not a missing blocker |
| lease_term via lease_term_months | cleared; lease_term is not a missing blocker |
| premises_use via permitted_use | still blocks because permitted_use is genuinely missing |

This confirms the Phase 46 alias fix still holds on the third document. It also reveals a separate extraction quality issue: property_address is populated but wrong (3826 MAUpin DR instead of the premises location), so the alias fix is behaving correctly while the extracted address needs review.

## Extraction Mode Distribution

| Row set | explicit | unknown |
| --- | ---: | ---: |
| standard fields | 28 | 60 |
| visible rows | 33 | 80 |

No inferred/calculated/reviewer-entered/manual modes were produced by this uploaded-file-only run.

## CAM, Expenses, Recoveries, Budget Preview

CAM/expense facts are present in the document text, but structured rule rows were not produced because enrichment failed and the available payload does not include provider-enriched expense/CAM rule outputs.

| Area | Result |
| --- | --- |
| expense rule rows | 0 |
| CAM rule rows | 0 |
| Expenses / Recoveries tab rows | 3 standard rows only |
| CAM Rules tab rows | 8 rows, mostly standard CAM inputs |
| Budget Preview rows | 7, read-only references |

CAM tab values observed:

- Square Footage: missing
- Cam Amount: missing
- Cam Cap Type: missing
- Cam Cap Pct: missing
- Admin Fee Pct: 5
- Management Fee Basis: gross_rent
- Gross Up Enabled: missing
- Gross Up Threshold: missing

Budget Preview is correctly read-only in this normalized output:

- Lease Type: editable=false, value=missing
- Square Footage: editable=false, value=missing
- Commencement Date: editable=false, value=missing
- Expiration Date: editable=false, value=missing
- Rent Commencement Date: editable=false, value=missing
- Monthly Rent: editable=false, value=missing
- Annual Rent: editable=false, value=missing

## Clause Records

Clause Records count: **0**.

No duplicate clause records were produced, but this is mostly because no clause records were produced at all. For a CAM-heavy base lease, this is a coverage gap, not a duplicate/noise issue. The document has clear CAM, taxes, insurance, rent addendum, and security deposit addendum language that should eventually project as clause summaries or structured rules.

## Evidence Integrity

Populated fields without verified source:

- 'billing_frequency': value='monthly', status=needs_review, sourcePage=1
- 'admin_fee_pct': value='5', status=needs_review, sourcePage=3
- 'management_fee_basis': value='gross_rent', status=needs_review, sourcePage=3
- 'renewal_notice_months': value='6', status=needs_review, sourcePage=null

Source-backed fields missing source page:

- 'lease_date'
- 'tenant_signatory_name'
- 'landlord_signatory_name'
- 'property_address'
- 'commencement_date'
- 'rent_commencement_date'
- 'assignment_consideration'
- 'property_insurance_responsibility'
- 'tenant_insurance_required'
- 'general_liability_min'
- 'waiver_of_subrogation'
- 'additional_insureds_required'
- 'landlord_consent'
- 'all_other_terms_remain_same'
- 'tenant_signature_date'

Important evidence observations:

- landlord_name, tenant_name, unit_number, lease_date, and lease_term_months are good source-backed values.
- property_address is source-backed but appears to be the tenant notice address, not the premises/property location.
- admin_fee_pct and management_fee_basis have relevant source text, but source verification is false because source-text quality/evidence metadata is incomplete.
- Several source-backed fields have source text but no page number.

## Obvious Extraction Errors Or Gaps

1. property_address extracted as 3826 MAUpin DR, but source text confirms the premises are at 12350 South Northshore, Knoxville, TN 37922 in The Markets at Choto.
2. property_name is missing even though The Markets at Choto is present in source text.
3. square_footage is missing even though page 1 states 3,002 rentable square feet and 2,848 buildable square feet.
4. cam_amount is missing even though source text contains $5.25 per leasable square foot.
5. monthly_rent, annual_rent, and rent schedule values are missing even though a Rent Addendum exists.
6. security_deposit is missing even though a Security Deposit Addendum exists.
7. lease_type is missing despite strong pro-rata taxes/insurance/CAM language suggesting a recoveries-heavy lease structure.
8. No structured expense rules, CAM rules, or clause records were produced from a CAM-heavy base lease.

## Comparison Against Prior Documents

| Behavior | Assignment doc | Phase 45 base lease | Phase 47 Craven Wings base lease |
| --- | --- | --- | --- |
| profile | assignment | base_lease | base_lease |
| assignment downgrades | applied | not applied | not applied |
| base lease blockers | suppressed | active | active |
| Phase 46 alias fix | assignment unaffected | fixed false premises_address blocker | still holds |
| original lease gap | advisory | not applicable | not applicable |
| CAM/expense coverage | advisory due assignment context | limited by extraction | source-rich but structured rows absent due failed enrichment/payload coverage |

## Source Change Recommendation

Do **not** change source in Phase 47. Documented follow-up only.

Recommended follow-up fix phase:

- Add a CAM/expense-heavy base lease extraction coverage phase that improves no-provider fallback from docling_raw/normalized_output into structured expense/CAM rule rows and clause records, without requiring provider enrichment to succeed.
- Specifically test property address/premises selection, square footage, CAM estimate, admin fee evidence verification, rent addendum extraction, security deposit addendum extraction, and pro-rata taxes/insurance/CAM rules.

## Verification

| Check | Result |
| --- | --- |
| temporary fixture/test file deleted | yes |
| source code changed | no |
| targeted normalizer QA | passed, 1 file / 1 test |
| QA JSON parse | passed after update |

## Recommendation

**No Gate.**

This document is a useful third QA data point because it is a true base lease with CAM/expense-heavy language, but the extracted structured CAM/expense/rent/security-deposit coverage is not strong enough for gating. Keep advisory-only.
