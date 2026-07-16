# Enterprise Document Intelligence v3 Phase 30 Business Review

Generated: 2026-07-15
Phase: 30
Status: Business-review report for local reconstructed diagnostic claims/evidence

## 1. Executive Summary

Phase 30 reviewed the local-only diagnostic claims/evidence reconstructed in Phase 29 for the approved assignment document. This is a business review artifact only. It does not change approval behavior, extraction behavior, Lease Review rows, or production data.

The local diagnostic run now has 82 projections, 13 reconstructed legacy-derived claims, 13 evidence rows, and 8 validation drops. The evidence mismatch improved from zero durable evidence rows, but it is not resolved. Recommendation remains **No Gate**.

## 2. Approved Document IDs

| ID Type | Value |
| --- | --- |
| org_id | `1307dd95-e7c5-4e08-833e-749444e8f4c8` |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

## 3. Profile and Document Type

| Attribute | Value |
| --- | --- |
| profile_key | `assignment` |
| profile_status | `auto_detected` |
| document signal | Assignment, Assumption and Amendment of Lease |
| profile changed in Phase 30 | no |

Business interpretation: the document should remain treated as an assignment-style document for advisory diagnostics. The title also contains assumption/amendment language, but Phase 30 is not a profile-changing phase.

## 4. Reconstructed Claims Summary

| Metric | Count |
| --- | ---: |
| canonical projections | 82 |
| reconstructed diagnostic claims | 13 |
| claim type | `legacy_field_projection` |
| evidence rows | 13 |
| evidence sufficiency | partial |

The reconstructed claims are conservative field-value claims only. They do not create legal obligations, CAM/expense rules, clause claims, or approval gates.

## 5. Evidence Summary

Each reconstructed claim has a direct source-text evidence row. Evidence pages are preserved where available. No polygon or block coordinates were fabricated.

| Metric | Count |
| --- | ---: |
| claims with direct quote evidence | 13 |
| claims without evidence | 0 among reconstructed claims |
| populated projection still source-less | 1 |
| source-less field | `tenant_name` |

## 6. Source-Backed Fields

The following fields were source-backed enough for diagnostic claim/evidence reconstruction:

- `all_other_terms_remain_same`
- `amended_base_rent_for_additional_year`
- `assignee_name`
- `assignee_notice_address`
- `assignment_consideration`
- `assignment_effective_date`
- `assignment_provisions`
- `assumption_scope`
- `landlord_consent`
- `property_address`
- `security_deposit`
- `square_footage`
- `tenant_signatory_name`

## 7. Source-Less or Weak-Evidence Fields

The following field remains populated but source-less:

- `tenant_name`: value exists, but no usable source text/evidence row was available. It should remain **Needs business review** and should not be promoted into a claim until evidence is provided.

Weak or rejected evidence cases are listed in the validation drop table below.

## 8. Validation Drops

Total validation drops after Phase 30 review: 8.

| Reason | Count |
| --- | ---: |
| Required field `end_date` is missing | 2 |
| Required field `start_date` is missing | 2 |
| `signature_date_sourced_from_original_lease_date` | 2 |
| `source_text_does_not_support_numeric_term_months` | 1 |
| `source_text_does_not_support_status_value` | 1 |

## 9. Skipped/Dropped Fields

| Field | Dropped Value | Reason | Source Text Summary | Correct Handling |
| --- | --- | --- | --- | --- |
| `landlord_signature_date` | 2018-02-01 | `signature_date_sourced_from_original_lease_date` | Source text refers to the original lease date, not a landlord signature date. | Do not use as signature date; keep as validation drop pending original/signature evidence. |
| `tenant_signature_date` | 2018-02-01 | `signature_date_sourced_from_original_lease_date` | Source text refers to original lease date, not tenant signature date. | Do not use as tenant signature date; keep as validation drop. |
| `lease_term_months` | 140 | `source_text_does_not_support_numeric_term_months` | Source says lease term extended by one year and references expiration context. | Do not accept numeric month calculation without supported derivation. |
| `status` | active | `source_text_does_not_support_status_value` | Source text only establishes agreement/effective date context. | Do not infer active status from effective date text alone. |
| `tenant_name` | NARENDRA PYDI | `source_less_populated_field` | No usable source text on the populated projection. | Do not create claim/evidence until source text or field evidence is available. |

## 10. Assignment False Full-Lease Blocker Finding

Current review path still applies false full-lease-style blockers to this assignment document. The visible blocker fields remain:

- `annual_rent`
- `base_year`
- `cam_amount`
- `expense_stop`
- `lease_type`
- `monthly_rent`
- `rent_per_sf`

The v3 profile-aware path avoids making these a hard full-lease approval gate. This distinction should stay: assignment documents should not be forced to behave like full base leases when the original lease is missing.

## 11. Related Document Gap: Original Lease Missing

| Diagnostic | Value |
| --- | --- |
| required document type | `original_lease` |
| status | `missing` |
| importance | high |
| candidate documents | none |
| linked documents | none |
| advisory/current-truth gap | yes |
| hard gate | no |

Original lease is required for full CAM, budget, and current-truth analysis. Its absence should remain an advisory related-document/current-truth gap, not a fake field failure.

## 12. Temporal/Supersession Limitation

| Diagnostic | Value |
| --- | --- |
| temporal status | `blocked_missing_related_document` |
| timeline available | no |
| blocked by missing original lease | yes |
| diagnostic only | yes |
| approval gate | no |

Temporal/current-truth analysis is limited because the original lease is missing and the local package has no linked prior document to order or compare.

## 13. Business Questions

- Are the 13 reconstructed source-backed fields acceptable as advisory review evidence?
- Should `tenant_name` remain blocked from claim creation until source text is available?
- Should assignment documents display original lease as a related-document gap instead of forcing full lease economics as missing fields?
- Are `landlord_signature_date` and `tenant_signature_date` correctly rejected when sourced from the original lease date?
- Is `lease_term_months` too risky to calculate without explicit supporting derivation?
- Should business users approve a one-document true fact-ledger extraction test if reconstructed evidence remains insufficient?

## 14. Recommendation: No Gate

**Recommendation: No Gate.**

Phase 30 confirms that reconstructed legacy-derived evidence is useful for business review, but it is not enough to make v3 advisory a hard approval gate. The run still lacks full durable fact-ledger coverage, the original lease is missing, and current-truth/temporal diagnostics remain incomplete.

## 15. Recommended Next Technical Step

### Option 1: Continue with reconstructed legacy-derived evidence

Pros:

- No LLM/API calls.
- No extraction rerun.
- Safe local QA path.

Cons:

- Incomplete durable claims/evidence.
- Cannot prove full v3 fact-ledger behavior.
- Still weak for approval gating.

### Option 2: Run true `vertex_fact_ledger` extraction for this one approved document only, local/staging, behind explicit flags

Pros:

- Real claim/evidence ledger.
- Tests intended architecture.
- Better approval advisory quality.

Cons:

- Requires explicit provider/model approval.
- May involve Vertex/Gemini cost.
- Must remain non-global and non-production.

Recommended next step: proceed to a controlled one-document `vertex_fact_ledger` test only after business review confirms reconstructed evidence is insufficient.

## Claim Review Table

| Field / Claim | Value | Evidence Page | Source Text Summary | Confidence | Status | Business Review |
| --- | --- | --- | --- | --- | --- | --- |
| `all_other_terms_remain_same` | true | 1 | All other terms of the Lease shall remain the same. | 1 | passed | Needs business review |
| `amended_base_rent_for_additional_year` | 118849.5 | 1 | Base Rent for the additional one year shall be $118,849.50. | 1 | passed | Needs business review |
| `assignee_name` | NARENDRA PYDI | 1 | NARENDRA PYDI, a resident of [redacted] (Assignee). | 1 | passed | Needs business review |
| `assignee_notice_address` | 1240 BENTLEY PARK LN, KNOXVILLE, TN-37922 | 2 | Assignee notice address is listed as 1240 Bentley Park Ln, Knoxville, TN. | 1 | passed | Needs business review |
| `assignment_consideration` | 10 | 1 | Consideration of Ten and No/100 Dollars ($10.00). | 0.92 | passed | Needs business review |
| `assignment_effective_date` | 2023-11-07 | 1 | Agreement entered into as of November 7, 2023, the Effective Date. | 1 | passed | Needs business review |
| `assignment_provisions` | ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE | 1 | Document title states Assignment, Assumption and Amendment of Lease. | 0.92 | passed | Needs business review |
| `assumption_scope` | Assignee hereby assumes the obligations | 1 | Assignee hereby assumes the obligations. | 0.92 | passed | Needs business review |
| `landlord_consent` | true | 1 | Landlord consents to assignment and assumption subject to this Agreement. | 1 | passed | Needs business review |
| `property_address` | 7804 Montvue Center Way, Knoxville, Tennessee, all as more particularly | 0 | Premises located at 7804 Montvue Center Way, Knoxville, Tennessee. | 0.92 | passed | Needs business review |
| `security_deposit` | 8575 | 2 | Assignee shall pay Security Deposit of $8,575.00. | 1 | passed | Needs business review |
| `square_footage` | 4200 | 1 | Approximately 4,200 rentable square feet. | 0.92 | passed | Needs business review |
| `tenant_signatory_name` | Doug Fleming | 0 | Signature block shows By: Doug Fleming. | 0.92 | passed | Needs business review |
