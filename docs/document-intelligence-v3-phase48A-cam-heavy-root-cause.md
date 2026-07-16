# Document Intelligence v3 Phase 48A: CAM-Heavy Base Lease Root Cause

Generated: 2026-07-15

## Executive Summary

Phase 48A root-caused the CAM-heavy base lease gaps found in Phase 47 for **Craven Wings Lease Executed 1.pdf**.

This was uploaded-file-only structured payload validation. No reliable leases row was used. No source code was changed, no provider was called, no extraction was rerun, and no remote read/write occurred.

Recommendation remains: **No Gate**.

## Candidate

| Item | Value |
| --- | --- |
| uploaded_file_id | 0155251a-b911-408c-ae83-469d8d6eb534 |
| org_id | 1307dd95-e7c5-4e08-833e-749444e8f4c8 |
| file | Craven Wings Lease Executed 1.pdf |
| document_subtype | base_lease |
| test type | uploaded-file-only structured payload validation |
| reliable leases row used | no |

Validated as not the approved assignment document and not the Phase 45 base lease. The source artifact is a real Craven Wings / Cress Family Restaurants / Markets at Choto lease export, not synthetic or stub data.

## Payload Layers Inspected

| Layer | Present | Notes |
| --- | --- | --- |
| docling_raw text/tables | yes | 26 pages; source text contains premises, CAM estimate, Rent Addendum, Security Deposit Addendum, tax/insurance/CAM language |
| parsed_data | yes | Flat structured row; missing many CAM/rent/security fields |
| normalized_output | yes | Mirrors parsed/validated fields and extraction debug metadata |
| ui_review_payload | yes | Review-ready payload with standard fields, but no workflow_output expense/CAM rules |
| valid_data | yes | Same core field-level gaps as parsed_data |
| standard fields after normalizeLeaseReviewData | yes | 88 standard fields; 32 populated; 56 missing; 0 expense rules; 0 CAM rules; 0 clause records |

Pipeline logs confirm parse and normalize completed. Enrichment failed because of compute resources, so provider-enriched results were not expected and were not required for this analysis.

## Root Cause Table

| Issue | Source layer finding | Structured payload finding | Normalizer finding | Root cause classification | Likely fix location |
| --- | --- | --- | --- | --- | --- |
| Wrong property_address | docling_raw contains the correct premises: Building 9, Suites 3 and 4, 12350 South Northshore, Knoxville, TN 37922, The Markets at Choto. It also contains tenant contact address text: Address: 3826 MAUpin DR. | parsed_data, valid_data, normalized_output, and ui_review_payload all carry 3826 MAUpin DR as property_address. | normalizeLeaseReviewData projects the supplied structured value and marks it needs_review; the Phase 46 alias fix is behaving correctly. | extraction_wrong_value | Backend premises/address selection in normalize-pdf-output / lease-workflow field extraction; field resolver context rules; evidence verifier should flag contact-address source text as weak for property_address. |
| Missing CAM estimate | docling_raw contains CAM estimate for 2021 is $5.25 per leasable square foot. | cam_amount is null in parsed_data, valid_data, normalized_output, and ui_review_payload. Expense recovery debug indicates the group parsed with all-null values. | cam_amount is missing; CAM Rules tab has no CAM estimate row beyond missing standard input. | extraction_missing; fallback_rule_gap | Expense/CAM fallback builders and extraction schema/prompt in lease-workflow / normalize-pdf-output; optional UI projection only after a structured CAM estimate exists. |
| Missing rent fields | docling_raw contains a Rent Addendum with a monthly minimum rent schedule. | monthly_rent, annual_rent, and rent_per_sf are null in parsed_data, valid_data, normalized_output, and ui_review_payload. | Budget Preview is read-only and correctly shows these as missing, but no rent schedule rows are available. | extraction_missing; fallback_rule_gap | Rent addendum table extractor / fallback builder in backend normalize-pdf-output / lease-workflow; schema support for schedules, not only scalar monthly_rent. |
| Missing security deposit | docling_raw contains Security Deposit Addendum and a total deposit of $15,535.36. | security_deposit is null in parsed_data, valid_data, normalized_output, and ui_review_payload. | security_deposit is a real base-lease blocker and remains missing. | extraction_missing; fallback_rule_gap | Security deposit addendum extraction rule/schema in normalize-pdf-output / lease-workflow; addendum fallback parser. |
| Missing structured expense/CAM rules | docling_raw contains pro-rata taxes, insurance premiums, CAM obligations, admin/management fee language, and CAM estimate. | Some flat fields exist, including tax_responsibility, insurance_responsibility, admin_fee_pct, and management_fee_basis, but workflow_output and expense/CAM rule arrays are absent. | expenseRules = 0 and camRules = 0; Expenses / Recoveries and CAM tabs show standard fields only. | fallback_rule_gap; extraction_missing | Backend expense/CAM rule extraction and fallback builders; leaseReviewFieldNormalizer normalizeExpenseRuleFallback only if alternate structured rule-like data is added. |
| Missing clause records | Source text has CAM, taxes, insurance, rent, security deposit, use, term, and option language. | docling_raw metadata reports lease_clauses_count 0 and no clause record arrays are present in ui_review_payload or normalized_output. | clauseRecords = 0; no duplicate/noise issue because no rows were created. | extraction_missing; fallback_rule_gap | Backend clause extraction / clause fallback generation; frontend normalizeClauseRecords only after clause-like payloads exist. |
| Evidence gaps | Source text exists for several populated fields, and docling page text is available. | Some fields have source_text but source_page is null; several fields keep source_quality pending_enrichment after enrichment failure. | Populated fields such as admin_fee_pct, management_fee_basis, billing_frequency, and renewal_notice_months are not evidence-verified; multiple source-backed rows lack page numbers. | evidence_mapping_gap | leaseReviewSchema evidence verification helpers; backend page/source-text mapping in normalize-pdf-output and canonical layout mapping. |

## Field-Level Root Cause Notes

### Property / Premises

The correct premises appears in docling_raw near the lease opening language. The wrong value, 3826 MAUpin DR, appears in tenant contact/notice-style text. Because the wrong value already exists in parsed_data, valid_data, normalized_output, and ui_review_payload, this is not a normalizer projection bug. The normalizer is faithfully projecting a bad upstream structured value.

Recommended fix priority: **P0**.

### CAM Estimate

The CAM estimate is source-visible but never becomes a structured field. This is a fallback and extraction coverage gap. A no-provider fallback should be able to recognize the CAM estimate phrase and project at least an advisory CAM amount / estimate row with source text and page.

Recommended fix priority: **P1**.

### Rent Addendum

The Rent Addendum exists in source, but the structured payload has no scalar monthly_rent, annual_rent, rent_per_sf, or rent schedule projection. This is likely a table/addendum extraction gap. A durable fix should model rent schedules separately instead of forcing every rent addendum into one scalar monthly_rent.

Recommended fix priority: **P1**.

### Security Deposit Addendum

The Security Deposit Addendum source text includes the total deposit. The structured field remains null across all payload layers. This is a strong candidate for a narrow fallback parser because the addendum heading and dollar amount are explicit.

Recommended fix priority: **P1**.

### Expense / CAM Rules

The payload contains partial flat responsibility fields but no rule rows. That means Lease Review cannot show the CAM/expense-heavy business content as Excel-style rules even though the text exists. The likely fix belongs in backend rule extraction/fallback first, with the frontend normalizer consuming rule-shaped outputs afterward.

Recommended fix priority: **P1**.

### Clause Records

Clause Records are absent, not duplicated. For this source-rich base lease, zero clause records indicates the backend clause extraction/fallback path did not populate any clause-like structures. This is lower priority than the field/rule blockers, but still important for reviewer context.

Recommended fix priority: **P2**.

### Evidence Completeness

Several values have source text but incomplete evidence metadata, especially page numbers and evidence verification status. Enrichment failure contributes to the pending_enrichment state, but page/source mapping should still degrade gracefully using docling/canonical layout.

Recommended fix priority: **P2**.

## Prioritized Phase 48B Scope

| Priority | Fix area | Scope |
| --- | --- | --- |
| P0 | Correct property/premises selection | Prefer lease premises/property context over tenant/contact address context; add validation that contact-address snippets do not satisfy property_address without review. |
| P1 | CAM/expense rule extraction/fallback | Create no-provider fallback rows for CAM estimate, pro-rata taxes, insurance, CAM, admin/management fee, and recovery obligations when source text is present. |
| P1 | Rent addendum and security deposit addendum projection | Extract rent schedule/addendum facts and security deposit total from docling_raw/normalized source text without requiring enrichment. |
| P2 | Clause records for CAM-heavy leases | Add clause fallback coverage for CAM, taxes, insurance, rent addendum, security deposit, use, and options with deduping. |
| P2 | Page/evidence completeness | Improve page backfill and evidence verification for source-backed fields when enrichment fails. |

## Source Changes Recommended

Yes, but not in Phase 48A.

Recommended Phase 48B should be a narrow implementation phase that changes extraction/fallback/projection code only after this report is reviewed. Approval behavior should remain unchanged until the new outputs are manually reviewed.

## Recommendation

**No Gate.**

The document is a useful real CAM-heavy base lease test. The source contains the business facts, but the current structured payload and fallback path do not reliably project CAM, expense, rent, security deposit, clause, or evidence detail. Keep v3 and these Lease Review diagnostics advisory-only.
