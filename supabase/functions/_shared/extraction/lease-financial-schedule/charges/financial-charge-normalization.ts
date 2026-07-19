// @ts-nocheck
import { FINANCIAL_CHARGE_TYPES } from "./financial-charge-types.ts";

const CHARGE_TYPE_SET = new Set(FINANCIAL_CHARGE_TYPES);
const ALIASES: Record<string, string> = {
  cam: "cam_estimate",
  common_area_maintenance: "cam_estimate",
  cam_charge: "cam_estimate",
  op_ex: "operating_expense_estimate",
  operating_expenses: "operating_expense_estimate",
  tax: "tax_estimate",
  taxes: "tax_estimate",
  insurance: "insurance_estimate",
  utilities: "utility_charge",
  management: "management_fee",
  admin_fee: "administrative_fee",
  security: "security_deposit",
  deposit: "security_deposit",
  prepaid: "prepaid_rent",
  ti_allowance: "tenant_improvement_allowance",
  tenant_allowance: "tenant_improvement_allowance",
  ll_contribution: "landlord_contribution",
  landlord_allowance: "landlord_contribution",
  reimbursement_allowance: "reimbursement",
  amortized_ti: "amortized_improvement_charge",
  equipment_rent: "equipment_charge",
  percent_rent: "percentage_rent",
  percentage: "percentage_rent",
};

export function normalizeFinancialChargeType(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const normalized = String(input).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return null;
  const aliased = ALIASES[normalized] ?? normalized;
  return CHARGE_TYPE_SET.has(aliased) ? aliased : null;
}
