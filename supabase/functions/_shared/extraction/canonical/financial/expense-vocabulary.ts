// @ts-nocheck
/**
 * Canonical expense vocabulary (Phase 6A, correction A).
 *
 * Deliberately independent of any Phase 5 specialist schema -- the stable
 * canonical model must not depend on a model-specific input contract.
 * ResponsibleParty here is byte-identical in VALUES to
 * schemas/domains/expense-specialists/cam-obligation.schema.ts's own
 * ResponsibleParty, but is its own definition, not an import; converters
 * (expense-obligation-converters.ts) map explicitly from each specialist
 * schema's own vocabulary into this one.
 */

export type ResponsibleParty = "tenant" | "landlord" | "shared" | "mixed" | "conditional" | "not_stated";

/** Coarse grouping, one level above category -- lets a consumer reason
 *  about "all insurance obligations" without enumerating every insurance
 *  ExpenseCategory value. Set per converter (expense-obligation-converters.ts). */
export type ExpenseFamily = "cam" | "tax" | "insurance" | "utility" | "repair" | "fee" | "other";

export type ExpenseCategory =
  | "common_area_maintenance"
  | "operating_expenses"
  | "real_estate_taxes"
  | "personal_property_taxes"
  | "property_insurance"
  | "tenant_property_insurance"
  | "leasehold_improvements_insurance"
  | "liability_insurance"
  | "business_interruption_insurance"
  | "workers_compensation_insurance"
  | "electricity"
  | "water"
  | "sewer"
  | "gas"
  | "hvac"
  | "telecommunications"
  | "interior_repairs"
  | "structural_repairs"
  | "roof_repairs"
  | "common_area_maintenance_work"
  | "management_fee"
  | "administrative_fee"
  | "other";

export type ExpensePaymentMechanism =
  | "direct_payment"
  | "reimbursement"
  | "additional_rent"
  | "included_in_base_rent"
  | "operating_expense_pass_through"
  | "separately_metered"
  | "submetered"
  | "not_stated";

export type ExpenseAllocationMethod =
  | "pro_rata_share"
  | "fixed_percentage"
  | "actual_cost"
  | "direct_meter"
  | "submeter"
  | "formula"
  | "included"
  | "not_stated";

export type ExpenseAmountType = "fixed_amount" | "percentage" | "pass_through" | "formula" | "included" | "not_stated";

export type ExpenseObligationType =
  | "must_pay"
  | "must_perform"
  | "must_insure"
  | "may_insure"
  | "must_reimburse"
  | "included_service"
  | "waiver"
  | "not_stated";

/** Tri-state audit-right (correction C) -- CAM's free-text auditRight
 *  cannot be safely collapsed to a boolean by non-nullness alone ("no
 *  right to audit" and "may audit within 90 days" are both non-null, one
 *  is false and one is true). See expense-obligation-converters.ts's
 *  normalizeAuditRight(). */
export interface CanonicalAuditRight {
  allowed: boolean | null;
  rawText: string | null;
  noticePeriodDays: number | null;
  conditions: string[];
}
