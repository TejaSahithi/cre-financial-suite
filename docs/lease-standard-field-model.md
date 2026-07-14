# Lease Standard Field Model

This is a living spec, grounded in the extraction pipeline's actual code as of this commit — not aspirational, and not yet enforced anywhere beyond what the referenced files already do:

- `supabase/functions/_shared/extraction/schemas.ts` — `LEASE_SCHEMA` (82 unique field keys; the base vocabulary for `field_key`/`label`/`data_type`/`validation_rule`, and the schema both `legacy_hybrid` and `vertex_fact_ledger` map onto).
- `supabase/functions/_shared/extraction/payload-guard.ts` — `CORE_FIELD_CATEGORIES` / `computeCoreReady()` (source of `required_for_approval`).
- `supabase/functions/_shared/extraction/lease-workflow.ts` — `buildBudgetHandoffReadiness()` (source of `required_for_budget`), `deriveCamProfile()` (source of `required_for_cam`).
- `supabase/functions/_shared/extraction/vertex-fact-ledger/approval-blockers.ts` — `PROFILE_BLOCKER_RULES` (source of `required_by_document_profile`).

Any future extraction provider — `vertex_fact_ledger` included — should be evaluated against this document, not against `LEASE_SCHEMA` alone.

## Known cross-schema gaps (read this before the tables)

The codebase currently has **three overlapping field vocabularies** that don't fully agree with each other. This document uses `LEASE_SCHEMA` as the base (it's the only one with real types/validation, and it's what both extraction providers write to), but the gaps below are real and worth fixing eventually, not hidden:

1. **`lease-workflow.ts`'s own field vocabulary (`FIELD_SPECS`) uses different key names for the same concepts.** `buildBudgetHandoffReadiness()`'s `budgetFieldKeys` list literally reads `["base_rent_monthly", "annual_rent", "rent_per_sf", "billing_frequency", "commencement_date", "expiration_date", "lease_type", "tenant_rsf"]` — but `LEASE_SCHEMA` has no `base_rent_monthly` or `tenant_rsf` keys. The real equivalents are `monthly_rent` and `square_footage`. This document maps `required_for_budget` onto the correct `LEASE_SCHEMA` keys (`monthly_rent`, `square_footage`), not the literal `budgetFieldKeys` strings.
2. **Two fields CAM calculation needs have no `LEASE_SCHEMA` entry at all**: `building_rsf` (whole-building square footage, distinct from the leased premises `square_footage`) and `tenant_pro_rata_share` (tenant's % share of the building, used to allocate CAM pool costs). Both are read directly out of `lease-workflow.ts`'s own field map in `deriveCamProfile()`, never validated, never part of the reviewable standard-field set. Listed at the bottom of `budget_inputs` as gap fields.
3. **Duplicate representations of the same concept**: `tax_responsibility` (free-text string, e.g. `"tenant"`) and `responsibility_taxes` (enum: `landlord`/`tenant`/`shared`/`landlord_with_cap`) both exist and both mean "who pays real estate taxes." Same pattern for `insurance_responsibility` (string) vs. `responsibility_insurance` (enum). Both members of each pair are listed below since both are real, live schema keys — but only the enum member is safe to build automated CAM logic against; the string member is display/LLM-summary only.
4. **Two `LEASE_SCHEMA` keys are defined twice**, and the second definition silently wins at runtime (last object-literal assignment wins in JS): `tenant_insurance_required` (lines ~509 and ~849) and `general_liability_min` (lines ~516 and ~856). The two definitions are near-duplicates with slightly different `labels`/`patterns`; this document lists each key once, using the second (winning) definition.
5. **Five fields are referenced in `LEASE_GROUPS`** (the field list the LLM extractor is prompted with) **but have no `LEASE_SCHEMA` entry**, so they're extracted but never validated, never part of `getSchema()`'s field set, and never shown as a standard field in review: `landlord_address`, `tenant_address`, `tenant_contact_name`, `tenant_contact_phone`, `landlord_consent_for_transfer`. Not included in the 82-field count below; flagged here as a real product gap (these are genuinely useful fields — landlord/tenant notice addresses in particular — that currently fall on the floor).

## Legend

- **required_for_approval**: gates `computeCoreReady()` — whether a lease is "worth opening for review" at all.
- **required_for_cam**: read by `deriveCamProfile()` to calculate CAM recovery/reconciliation.
- **required_for_budget**: in `buildBudgetHandoffReadiness()`'s field list — blocks Budget handoff if missing or unapproved.
- **required_by_document_profile**: which of `full_lease` / `assignment` / `amendment` / `assignment_amendment` (per `approval-blockers.ts`) treat this field as a hard blocker. `none` = advisory in every profile today.
- **evidence_required**: whether the field needs real `source_text`/`source_page` before being trusted (vs. commonly calculator-derived).
- **approval_impact**: one sentence — what breaks downstream if this field is missing or wrong.
- **validation_rule**: `LEASE_SCHEMA`'s actual `type`/`min`/`max`/`enumValues` constraint.

---

## document_identity

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| lease_date | Lease Date | date | false | false | false | none | true | Advisory — informs document dating, not a downstream gate. | date, YYYY-MM-DD |
| lease_type | Lease Type | enum | false | true | true | none | true | Drives CAM structure classification (`deriveCamProfile`) and Budget handoff's `budgetFieldKeys`. | enum: nnn, gross, modified_gross, nn, net |
| status | Lease Status | enum | false | false | false | none | false | Advisory record status; not a gate. | enum: active, expired, pending, vacant |
| notes | Notes | string | false | false | false | none | false | Free text, no downstream logic depends on it. | string |

## parties

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| tenant_name | Tenant | string | **true** | false | false | full_lease, amendment, minimal-floor | true | Core readiness gate — blocks review-open and every profile's approval blockers if missing. | string, required |
| landlord_name | Landlord | string | **true** | false | false | full_lease | true | `LEASE_SCHEMA`-required; blocks `full_lease` approval. | string, required |
| tenant_signatory_name | Tenant Signatory | string | false | false | false | none | true | Advisory — identifies the individual signer, not the tenant entity. | string |
| landlord_signatory_name | Landlord Signatory | string | false | false | false | none | true | Advisory. | string |
| broker_name | Broker / Brokerage | string | false | false | false | none | true | Advisory. | string |
| assignor_name | Assignor | string | false | false | false | assignment, assignment_amendment | true | Blocks assignment/assignment_amendment approval if missing. | string |
| assignee_name | Assignee | string | false | false | false | assignment, assignment_amendment | true | Blocks assignment/assignment_amendment approval if missing. | string |

## property_premises

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| property_address | Property Address | string | **true** | false | false | full_lease, amendment, minimal-floor | true | `LEASE_SCHEMA`-required; core readiness gate; blocks most profiles' approval. | string, required |
| property_name | Property Name | string | **true**\* | false | false | none | true | \*Satisfies the `property_address`/`property_name` core-readiness OR-category. | string |
| unit_number | Unit / Suite | string | false | false | false | none | true | Advisory — display/identification only. | string |
| square_footage | Rentable Square Footage (Premises) | number | **true**\* | true | **true**\*\* | none | true | \*Core readiness category on its own. \*\*Mapped from `lease-workflow.ts`'s `tenant_rsf` budget key — see gap #1 above. Also feeds `rent_per_sf`/CAM allocation. | number, min=0 |
| permitted_use | Permitted Use | string | false | false | false | none | true | Advisory — operational/legal context. | string |

## term_dates

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| start_date | Start Date | date | **true** | true | **true** | full_lease, minimal-floor | true | `LEASE_SCHEMA`-required; core readiness; feeds `deriveCamProfile`'s `cam_start_date`; budget handoff. | date, required |
| end_date | End Date | date | **true** | true | **true** | full_lease | true | `LEASE_SCHEMA`-required; core readiness; feeds `cam_end_date`; budget handoff. | date, required |
| commencement_date | Commencement Date | date | **true**\* | true | **true** | full_lease, minimal-floor | true | \*Satisfies `start_date`/`commencement_date` OR-category. Formulaic dates with no explicit calendar date must be `null`, not backfilled from `lease_date`. | date |
| expiration_date | Expiration Date | date | **true**\* | true | **true** | full_lease | true | \*Satisfies `end_date`/`expiration_date` OR-category. | date |
| rent_commencement_date | Rent Commencement Date | date | false | false | false | none | true | Advisory — may differ from term commencement under free-rent. | date |
| lease_term_months | Lease Term (Months) | number | false | false | false | none | false | Usually calculator-derived from `start_date`/`end_date` (`computeLeaseDerived`); extraction is a cross-check, not a hard requirement. | number, min=0 |
| assignment_effective_date | Assignment Effective Date | date | false | false | false | assignment, assignment_amendment | true | Blocks assignment/assignment_amendment approval if missing. | date |

## rent_charges

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| monthly_rent | Monthly Rent | number | **true**\* | false | **true** | none | true | \*Satisfies `monthly_rent`/`annual_rent` core-readiness OR-category. Mapped from budget's `base_rent_monthly` key — see gap #1. Primary Budget rent-schedule input. | number, min=1 |
| annual_rent | Annual Rent | number | **true**\* | false | **true** | none | false | \*Satisfies the same OR-category as `monthly_rent`. Commonly calculator-derived (`monthly_rent × 12`) when only monthly is extracted. | number, min=1 |
| rent_per_sf | Rent per Square Foot | number | false | false | **true** | none | false | Commonly calculator-derived (`annual_rent / square_footage`); in `budgetFieldKeys`. | number, min=0 |
| billing_frequency | Billing Frequency | enum | false | false | **true** | none | true | In `budgetFieldKeys` — determines how the rent schedule is billed. | enum: monthly, quarterly, annual |
| escalation_rate | Escalation Rate | number | false | false | false | none | true | Advisory — feeds `BudgetPreviewCard`'s escalation projection, not a hard gate. | number, 0–100 |
| escalation_type | Escalation Type | enum | false | false | false | none | true | Advisory. | enum: fixed_pct, cpi, stepped, fmv, none |
| escalation_timing | Escalation Timing | enum | false | false | false | none | true | Advisory. | enum: lease_anniversary, calendar_year, fiscal_year |
| security_deposit | Security Deposit | number | false | false | false | none | true | Advisory — accounting/collections context, not a CAM/budget gate. | number, min=0 |
| late_fee_amount | Late Fee | number | false | false | false | none | true | Advisory. | number, min=0 |
| returned_payment_fee_amount | Returned Payment Fee | number | false | false | false | none | true | Advisory. | number, min=0 |
| application_fee_amount | Application Fee | number | false | false | false | none | true | Advisory. | number, min=0 |
| administrative_fee_amount | Administrative Fee (lease-level) | number | false | false | false | none | true | Advisory — distinct from `admin_fee_pct` (the CAM administrative fee %). | number, min=0 |
| pet_fee_amount | Pet Fee | number | false | false | false | none | true | Advisory. | number, min=0 |
| pet_rent_amount | Pet Rent | number | false | false | false | none | true | Advisory. | number, min=0 |
| parking_fee_amount | Parking Fee | number | false | false | false | none | true | Advisory. | number, min=0 |
| ti_allowance | Tenant Improvement Allowance | number | false | false | false | none | true | Advisory — capex/TI tracking, not a CAM/budget gate today. | number, min=0 |
| free_rent_months | Free Rent (Months) | number | false | false | false | none | true | Advisory — should factor into rent schedule projections but isn't a hard budget-handoff gate today (a real gap: `BudgetPreviewCard`'s 12-month preview doesn't currently zero out free-rent months). | number, 0–60 |
| assignment_consideration | Assignment Consideration | number | false | false | false | none | true | Assignment-only; advisory. | number, min=0 |
| amended_base_rent_for_additional_year | Amended Base Rent (Additional Year) | number | false | false | false | none | true | Amendment-only; advisory. | number, min=0 |

## expenses_recoveries

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| base_year | Base Year | number | false | true | false | none | true | Modified Gross pass-through mechanism — required for correct CAM/tax/insurance reconciliation on Base Year leases. | number, 1900–2100 |
| expense_stop | Expense Stop | number | false | true | false | none | true | Modified Gross pass-through mechanism — expense cap above which tenant pays excess. | number, min=0 |

## cam_rules

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| cam_amount | CAM Amount | number | false | true | false | none | true | Explicit dollar CAM figure, when the lease states one directly. | number, min=0 |
| cam_cap_type | CAM Cap Type | enum | false | true | false | none | true | Determines how `cam_cap_pct` compounds year over year. | enum: none, cumulative, non_cumulative, compounding |
| cam_cap_pct | CAM Cap Percent | number | false | true | false | none | true | Caps annual CAM/controllable-expense increases. | number, 0–100 |
| admin_fee_pct | CAM Administrative Fee % | number | false | true | false | none | true | Feeds recoverable-CAM administrative fee calculation. | number, 0–30 |
| management_fee_basis | Management Fee Basis | enum | false | true | false | none | true | Determines what base the management fee is calculated against. | enum: cam_pool_pro_rata, tenant_annual_rent, gross_rent, fixed |
| gross_up_enabled | Gross-Up Enabled | boolean | false | true | false | none | true | Whether variable expenses are grossed up to full occupancy for reconciliation. | boolean |
| gross_up_threshold | Gross-Up Occupancy Threshold | number | false | true | false | none | true | Occupancy % at which gross-up applies. | number, 0–100 |

## taxes

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| responsibility_taxes | Tax Responsibility (enum) | enum | false | true | false | none | true | Structured value — safe to build automated CAM/tax logic against (see gap #3). | enum: landlord, tenant, shared, landlord_with_cap |
| tax_responsibility | Tax Responsibility (text) | string | false | false | false | none | true | Free-text duplicate of `responsibility_taxes` (see gap #3) — display/summary only, not safe for automated logic. | string |

## insurance

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| responsibility_insurance | Insurance Responsibility (enum) | enum | false | false | false | none | true | Structured value (see gap #3). | enum: landlord, tenant, shared, landlord_with_cap |
| insurance_responsibility | Insurance Responsibility (text) | string | false | false | false | none | true | Free-text duplicate of `responsibility_insurance` (see gap #3). | string |
| property_insurance_responsibility | Property Insurance Responsibility | enum | false | false | false | none | true | Distinct from general `responsibility_insurance` — specifically who insures the building itself. | enum: landlord, tenant, shared, landlord_with_cap |
| tenant_insurance_required | Tenant Insurance Required | boolean | false | false | false | none | true | Legal/operational compliance flag. | boolean |
| general_liability_min | General Liability Minimum | number | false | false | false | none | true | Minimum CGL coverage tenant must carry. | number, min=0 |
| waiver_of_subrogation | Waiver of Subrogation | boolean | false | false | false | none | true | Legal/operational compliance flag. | boolean |
| additional_insureds_required | Additional Insureds Required | boolean | false | false | false | none | true | Legal/operational compliance flag — landlord named on tenant's policy. | boolean |

## utilities

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| responsibility_utilities | Utilities Responsibility | enum | false | false | false | none | true | Structured who-pays value for electric/water/gas/sewer collectively. | enum: landlord, tenant, shared, landlord_with_cap |
| electric_responsibility | Electric Responsibility | string | false | false | false | none | true | Free-text, electric-specific. | string |
| water_sewer_responsibility | Water/Sewer Responsibility | string | false | false | false | none | true | Free-text, water/sewer-specific. | string |
| utility_reimbursement_amount | Utility Reimbursement Amount | number | false | false | false | none | true | Advisory — explicit dollar reimbursement, if stated. | number, min=0 |
| water_sewer_reimbursement_amount | Water/Sewer Reimbursement Amount | number | false | false | false | none | true | Advisory. | number, min=0 |

## repairs_maintenance

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| responsibility_repairs | Repairs & Maintenance Responsibility | enum | false | false | false | none | true | Advisory — operational context, not a CAM calculation input directly. | enum: landlord, tenant, shared, landlord_with_cap |
| hvac_responsibility | HVAC Responsibility | enum | false | true | false | none | true | Feeds CAM structure (`deriveCamProfile` reads it via the `cam_structure` LLM group). | enum: landlord, tenant, shared, landlord_with_cap |

## legal_options

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| renewal_options | Renewal Options | string | false | false | false | none | true | Advisory — legal/leasing-strategy context. | string |
| renewal_type | Renewal Type | enum | false | false | false | none | true | Advisory. | enum: fixed_term, fair_market, fixed_increase, cpi_indexed, negotiated, automatic, none |
| right_of_first_refusal | Right of First Refusal | boolean | false | false | false | none | true | Advisory — legal/leasing-strategy context. | boolean |
| early_termination_option | Early Termination Option | boolean | false | false | false | none | true | Advisory. | boolean |
| assignment_provisions | Assignment Provisions (Summary) | string | false | false | false | none | true | Advisory — 1-2 sentence summary of assignment/subletting rules. | string |
| default_cure_period | Default Cure Period (Days) | number | false | false | false | none | true | Advisory — legal/operational timeline context. | number, min=0 |
| landlord_consent | Landlord Consent (Assignment) | boolean | false | false | false | assignment, assignment_amendment | true | Blocks assignment/assignment_amendment approval if missing. | boolean |
| assumption_scope | Assumption Scope (Assignment) | string | false | false | false | none | true | Advisory — assignment-only. | string |
| all_other_terms_remain_same | All Other Terms Remain Same (Amendment) | boolean | false | false | false | amendment, assignment_amendment | true | Blocks amendment/assignment_amendment approval if missing. | boolean |

## critical_dates

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| option_exercise_deadline | Option Exercise Deadline | date | false | false | false | none | true | Advisory — missing this risks losing a renewal/extension option; not currently a system-enforced gate. | date |

## notices

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| renewal_notice_months | Renewal Notice Period (Months) | number | false | false | false | none | true | Advisory — operational reminder input, not a system-enforced gate. | number, min=0 |
| termination_notice_months | Termination Notice Period (Months) | number | false | false | false | none | true | Advisory. | number, min=0 |
| assignee_notice_address | Assignee Notice Address | string | false | false | false | none | true | Advisory — assignment-only. | string |

## signatures

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| tenant_signature_date | Tenant Signature Date | date | false | false | false | none | true | Advisory — execution-tracking context. | date |
| landlord_signature_date | Landlord Signature Date | date | false | false | false | none | true | Advisory. | date |

## budget_inputs

Cross-reference: `monthly_rent`, `annual_rent`, `rent_per_sf`, `billing_frequency`, `start_date`/`commencement_date`, `end_date`/`expiration_date`, `lease_type`, `square_footage` are all `required_for_budget = true` above (each listed once in its natural group, not repeated here). The two rows below are genuine gaps — needed for CAM/budget math today, with no `LEASE_SCHEMA` home yet (see "Known cross-schema gaps" #2):

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| building_rsf *(gap — no `LEASE_SCHEMA` entry)* | Building Total Rentable Square Footage | number | false | **true** | false | none | true | Read directly by `deriveCamProfile()`; never validated or reviewable today. Needed to compute `tenant_pro_rata_share` when not separately stated. | not yet defined |
| tenant_pro_rata_share *(gap — no `LEASE_SCHEMA` entry)* | Tenant Pro Rata Share | number | false | **true** | false | none | true | Read directly by `deriveCamProfile()`; drives whether CAM recovery requires `manualRequired` fallback. Never validated or reviewable today. | not yet defined |

## approval_controls

Every profile-specific blocker rule in `approval-blockers.ts` is already captured via the `required_by_document_profile` column on the fields above. The two rows below are the row-level (not field-level) controls that actually gate approval today — included here because they're the mechanism the `required_by_document_profile` column depends on, not because they're `LEASE_SCHEMA` fields:

| field_key | label | data_type | required_for_approval | required_for_cam | required_for_budget | required_by_document_profile | evidence_required | approval_impact | validation_rule |
|---|---|---|---|---|---|---|---|---|---|
| document_profile *(computed, not a `LEASE_SCHEMA` field)* | Document Profile | enum | **true** | false | false | all | n/a | Selects which `PROFILE_BLOCKER_RULES` set applies; a wrong classification silently applies the wrong blocker set. Computed today by regex (`detectDocumentProfileSignals`) or, under `vertex_fact_ledger`, by `classifyDocumentProfile()`. | enum: full_lease, assignment, amendment, assignment_amendment, abstract, addendum, exhibit |
| approval_status / review_status *(row-level, not a `LEASE_SCHEMA` field)* | Approval / Review Status | enum | **true** | false | false | all | n/a | `hasApprovedStatus(row?.abstract_status \|\| approval_status \|\| review_status \|\| status)` gates `buildBudgetHandoffReadiness()`'s `ready` flag directly — nothing publishes to Budget until this is approved. | lease row status field(s) |

---

## Coverage check

82 unique `LEASE_SCHEMA` field keys (84 definitions minus 2 shadowed duplicates — `tenant_insurance_required`, `general_liability_min`), each appearing exactly once across the 15 groups above that hold real schema fields (`document_identity` through `signatures`), plus 4 explicitly-flagged gap rows in `budget_inputs`/`approval_controls` that are **not** `LEASE_SCHEMA` fields today. No field is silently dropped; every gap is named as a gap, not glossed over.
