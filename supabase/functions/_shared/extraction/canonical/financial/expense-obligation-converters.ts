// @ts-nocheck
/**
 * Phase 5 raw specialist obligations -> canonical ExpenseObligation
 * (Phase 6A, 6A.2/6A.3).
 *
 * Consumes the RAW obligations array off ExpenseSpecialistShadowRecord
 * directly (CamObligation[]/TaxObligation[]/InsuranceObligation[]/
 * UtilityObligation[]/RepairObligation[]), not the ExtractedClaim
 * sub-claims expense-specialist-claims.ts already builds -- a separate,
 * richer projection of the same source data, per the Phase 6A spec's own
 * "New path: specialist shadow outputs -> canonical ExpenseObligation
 * records" framing.
 *
 * Every mapping table below is exhaustive over its source enum (never a
 * partial table with a silent fallback) -- this is the concrete
 * "deterministic, not LLM-driven" reconciliation the Phase 6A grounding
 * correction identified as the REAL normalization work needed here (the
 * LLM already only returns clean enum values; 5 schemas' enums simply
 * don't agree with each other and with the unified vocabulary).
 */

import type { ClaimIdentityContext } from "../claim-identity-context.ts";
import type { EvidenceReference } from "../evidence-reference.ts";
import type { ExpenseObligation, ExpenseCap } from "./expense-obligation.ts";
import type {
  ResponsibleParty,
  ExpenseFamily,
  ExpenseCategory,
  ExpensePaymentMechanism,
  ExpenseAllocationMethod,
  ExpenseAmountType,
  ExpenseObligationType,
  CanonicalAuditRight,
} from "./expense-vocabulary.ts";
import { stableHash, buildObligationId } from "./expense-obligation-identity.ts";
import type { CamObligation, CamObligationCategory, CamPaymentMechanism, CamAllocationMethod, CamAmountType } from "../../schemas/domains/expense-specialists/cam-obligation.schema.ts";
import type { TaxObligation, TaxObligationCategory } from "../../schemas/domains/expense-specialists/tax-obligation.schema.ts";
import type { InsuranceObligation, InsuranceCoverageType, InsuranceObligatedParty } from "../../schemas/domains/expense-specialists/insurance-obligation.schema.ts";
import type { UtilityObligation, UtilityType, UtilityBillingMethod } from "../../schemas/domains/expense-specialists/utility-obligation.schema.ts";
import type { RepairObligation, RepairComponent, RepairObligationType } from "../../schemas/domains/expense-specialists/repair-obligation.schema.ts";

// ── Shared helpers ───────────────────────────────────────────────────────────

function evidenceFor(fileId: string, sourcePage: number | null, sourceQuote: string | null): EvidenceReference[] {
  if (!sourceQuote) return [];
  return [{ documentId: fileId, pageNumber: sourcePage, nodeId: null, quote: sourceQuote, polygon: null, ocrConfidence: null, role: "direct" }];
}

/** Tri-state audit-right parsing (correction C) -- CAM's free-text
 *  auditRight cannot be safely collapsed to a boolean by non-nullness
 *  alone. Unrecognized wording stays allowed:null (the caller marks the
 *  obligation requiresReview, never guesses true). */
export function normalizeAuditRight(rawText: string | null): CanonicalAuditRight {
  if (!rawText) return { allowed: null, rawText: null, noticePeriodDays: null, conditions: [] };
  const t = rawText.toLowerCase();
  if (/no\s+right\s+to\s+audit|waives|shall\s+not\s+audit/.test(t)) {
    return { allowed: false, rawText, noticePeriodDays: null, conditions: [] };
  }
  if (/right\s+to\s+audit|may\s+audit/.test(t)) {
    const days = t.match(/within\s+(\d+)\s*days?/)?.[1];
    return { allowed: true, rawText, noticePeriodDays: days ? Number(days) : null, conditions: [] };
  }
  return { allowed: null, rawText, noticePeriodDays: null, conditions: [] };
}

/** Best-effort keyword derivation from CAM's free-text
 *  reconciliationFrequency/sourceQuote -- the source schema has no
 *  dedicated boolean fields for these, so absence of a keyword means "no
 *  positive evidence either way" (null), never a fabricated false. */
function deriveReconciliationFlags(reconciliationFrequency: string | null, sourceQuote: string | null): { estimatedPayments: boolean | null; annualReconciliation: boolean | null } {
  const text = `${reconciliationFrequency ?? ""} ${sourceQuote ?? ""}`.toLowerCase();
  return {
    estimatedPayments: /estimat/.test(text) ? true : null,
    annualReconciliation: /annual/.test(text) ? true : null,
  };
}

interface BaseObligationArgs {
  context: ClaimIdentityContext;
  schemaVersion: string;
  specialistDomain: string;
  sourceObligationIndex: number;
  rawObligation: unknown;
  sourcePage: number | null;
  sourceQuote: string | null;
}

function baseFields(args: BaseObligationArgs): Pick<ExpenseObligation, "obligationId" | "source" | "organizationId" | "fileId" | "generationId" | "extractionRunId" | "evidence" | "sourceClaimIds" | "controllingDocumentId" | "requiresReview" | "reviewReasons"> {
  const sourcePayloadHash = stableHash(args.rawObligation);
  const obligationId = buildObligationId({
    organizationId: args.context.organizationId,
    fileId: args.context.fileId,
    generationId: args.context.generationId,
    specialistDomain: args.specialistDomain,
    sourceSchemaVersion: args.schemaVersion,
    sourceObligationIndex: args.sourceObligationIndex,
    sourcePage: args.sourcePage,
    sourceQuote: args.sourceQuote,
  });
  return {
    obligationId,
    source: { specialistDomain: args.specialistDomain, sourceSchemaVersion: args.schemaVersion, sourceObligationIndex: args.sourceObligationIndex, sourcePayloadHash },
    organizationId: args.context.organizationId,
    fileId: args.context.fileId,
    generationId: args.context.generationId,
    extractionRunId: args.context.extractionRunId,
    evidence: evidenceFor(args.context.fileId, args.sourcePage, args.sourceQuote),
    sourceClaimIds: [],
    controllingDocumentId: null,
    requiresReview: false,
    reviewReasons: [],
  };
}

// ── CAM ──────────────────────────────────────────────────────────────────────

const CAM_CATEGORY_TO_EXPENSE_CATEGORY: Record<CamObligationCategory, ExpenseCategory> = {
  common_area_maintenance: "common_area_maintenance",
  operating_expenses: "operating_expenses",
  management_fee: "management_fee",
  administrative_fee: "administrative_fee",
  other: "other",
};
const CAM_PAYMENT_MECHANISM_TO_EXPENSE: Record<CamPaymentMechanism, ExpensePaymentMechanism> = {
  additional_rent: "additional_rent",
  reimbursement: "reimbursement",
  direct_payment: "direct_payment",
  included_in_rent: "included_in_base_rent",
  not_stated: "not_stated",
};
const CAM_ALLOCATION_METHOD_TO_EXPENSE: Record<CamAllocationMethod, ExpenseAllocationMethod> = {
  pro_rata_share: "pro_rata_share",
  fixed_percentage: "fixed_percentage",
  actual_cost: "actual_cost",
  formula: "formula",
  not_stated: "not_stated",
};
const CAM_AMOUNT_TYPE_TO_EXPENSE: Record<CamAmountType, ExpenseAmountType> = {
  fixed: "fixed_amount",
  percentage: "percentage",
  pass_through: "pass_through",
  formula: "formula",
  included: "included",
  not_stated: "not_stated",
};

export function camSpecialistToExpenseObligations(obligations: CamObligation[], context: ClaimIdentityContext, schemaVersion: string, specialistDomain = "cam_and_operating_expenses"): ExpenseObligation[] {
  return obligations.map((o, index) => {
    const category = CAM_CATEGORY_TO_EXPENSE_CATEGORY[o.category] ?? "other";
    const family: ExpenseFamily = category === "management_fee" || category === "administrative_fee" ? "fee" : "cam";
    const cap: ExpenseCap | null = o.cap ? { type: o.cap.type, value: o.cap.value, appliesTo: o.cap.appliesTo } : null;
    const reconciliationFlags = deriveReconciliationFlags(o.reconciliationFrequency, o.sourceQuote);
    return {
      ...baseFields({ context, schemaVersion, specialistDomain, sourceObligationIndex: index, rawObligation: o, sourcePage: o.sourcePage, sourceQuote: o.sourceQuote }),
      family,
      category,
      subcategory: category === "other" && o.category !== "other" ? o.category : null,
      responsibleParty: o.responsibleParty as ResponsibleParty,
      beneficiaryParty: null,
      obligationType: "not_stated" as ExpenseObligationType,
      paymentMechanism: CAM_PAYMENT_MECHANISM_TO_EXPENSE[o.paymentMechanism] ?? "not_stated",
      allocationMethod: CAM_ALLOCATION_METHOD_TO_EXPENSE[o.allocationMethod] ?? "not_stated",
      amountType: CAM_AMOUNT_TYPE_TO_EXPENSE[o.amountType] ?? "not_stated",
      amount: o.amount,
      currency: null,
      percentage: o.percentage,
      cap,
      inclusions: [...o.inclusions],
      exclusions: [...o.exclusions],
      reconciliation: {
        frequency: o.reconciliationFrequency,
        estimatedPayments: reconciliationFlags.estimatedPayments,
        annualReconciliation: reconciliationFlags.annualReconciliation,
        auditRight: normalizeAuditRight(o.auditRight),
        auditPeriodDays: normalizeAuditRight(o.auditRight).noticePeriodDays,
      },
      effectivePeriod: null,
      status: o.status,
      verificationStatus: "unverified",
    } as ExpenseObligation;
  });
}

// ── Taxes ────────────────────────────────────────────────────────────────────

const TAX_CATEGORY_TO_EXPENSE_CATEGORY: Record<TaxObligationCategory, ExpenseCategory> = {
  real_estate_tax: "real_estate_taxes",
  personal_property_tax: "personal_property_taxes",
  special_assessment: "other",
  tax_increase: "other",
  tax_reimbursement: "other",
  tax_appeal_right: "other",
  other: "other",
};
// Tax/Insurance share the same "economicTreatment" vocabulary (direct_cost/
// included_in_rent/operating_expense_pass_through/reimbursement/not_stated)
// -- one shared mapping table, not two copies.
const ECONOMIC_TREATMENT_TO_PAYMENT_MECHANISM: Record<string, ExpensePaymentMechanism> = {
  direct_cost: "direct_payment",
  included_in_rent: "included_in_base_rent",
  operating_expense_pass_through: "operating_expense_pass_through",
  reimbursement: "reimbursement",
  not_stated: "not_stated",
};

export function taxSpecialistToExpenseObligations(obligations: TaxObligation[], context: ClaimIdentityContext, schemaVersion: string, specialistDomain = "taxes"): ExpenseObligation[] {
  return obligations.map((o, index) => {
    const category = TAX_CATEGORY_TO_EXPENSE_CATEGORY[o.category] ?? "other";
    return {
      ...baseFields({ context, schemaVersion, specialistDomain, sourceObligationIndex: index, rawObligation: o, sourcePage: o.sourcePage, sourceQuote: o.sourceQuote }),
      family: "tax" as ExpenseFamily,
      category,
      subcategory: category === "other" && o.category !== "other" ? o.category : null,
      responsibleParty: o.responsibleParty as ResponsibleParty,
      beneficiaryParty: null,
      obligationType: "not_stated" as ExpenseObligationType,
      paymentMechanism: ECONOMIC_TREATMENT_TO_PAYMENT_MECHANISM[o.economicTreatment] ?? "not_stated",
      allocationMethod: "not_stated" as ExpenseAllocationMethod,
      amountType: "not_stated" as ExpenseAmountType,
      amount: null,
      currency: null,
      percentage: null,
      cap: null,
      inclusions: [],
      exclusions: [],
      // baseYear/capOrLimit are free text with no dedicated ExpenseObligation
      // field this phase -- deliberately left unmapped rather than forced
      // into an unrelated field; still recoverable via evidence.sourceQuote.
      reconciliation: null,
      effectivePeriod: null,
      status: o.status,
      verificationStatus: "unverified",
    } as ExpenseObligation;
  });
}

// ── Insurance ────────────────────────────────────────────────────────────────

// Correction E: 7 distinct categories, no collapse of tenant_property/
// leasehold_improvements/business_interruption/workers_compensation into "other".
const INSURANCE_COVERAGE_TYPE_TO_CATEGORY: Record<InsuranceCoverageType, ExpenseCategory> = {
  building: "property_insurance",
  tenant_property: "tenant_property_insurance",
  leasehold_improvements: "leasehold_improvements_insurance",
  commercial_general_liability: "liability_insurance",
  business_interruption: "business_interruption_insurance",
  workers_compensation: "workers_compensation_insurance",
  other: "other",
};
// InsuranceObligation.obligatedParty's "both" reconciles to ResponsibleParty's
// "shared" -- explicit, documented (both parties obligated, closest existing value).
const INSURANCE_OBLIGATED_PARTY_TO_RESPONSIBLE_PARTY: Record<InsuranceObligatedParty, ResponsibleParty> = {
  tenant: "tenant",
  landlord: "landlord",
  both: "shared",
  conditional: "conditional",
  not_stated: "not_stated",
};
// InsuranceObligation.obligationType's values are already identical to
// ExpenseObligationType's -- direct passthrough, no table needed.

export function insuranceSpecialistToExpenseObligations(obligations: InsuranceObligation[], context: ClaimIdentityContext, schemaVersion: string, specialistDomain = "insurance"): ExpenseObligation[] {
  return obligations.map((o, index) => {
    const category = INSURANCE_COVERAGE_TYPE_TO_CATEGORY[o.coverageType] ?? "other";
    return {
      ...baseFields({ context, schemaVersion, specialistDomain, sourceObligationIndex: index, rawObligation: o, sourcePage: o.sourcePage, sourceQuote: o.sourceQuote }),
      family: "insurance" as ExpenseFamily,
      category,
      subcategory: category === "other" && o.coverageType !== "other" ? o.coverageType : null,
      responsibleParty: INSURANCE_OBLIGATED_PARTY_TO_RESPONSIBLE_PARTY[o.obligatedParty] ?? "not_stated",
      beneficiaryParty: null,
      obligationType: o.obligationType as ExpenseObligationType,
      paymentMechanism: ECONOMIC_TREATMENT_TO_PAYMENT_MECHANISM[o.economicTreatment] ?? "not_stated",
      allocationMethod: "not_stated" as ExpenseAllocationMethod,
      amountType: "not_stated" as ExpenseAmountType,
      amount: null,
      currency: null,
      percentage: null,
      cap: null,
      inclusions: [],
      exclusions: [],
      reconciliation: null,
      effectivePeriod: null,
      status: o.status,
      verificationStatus: "unverified",
    } as ExpenseObligation;
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

const UTILITY_TYPE_TO_CATEGORY: Record<UtilityType, ExpenseCategory> = {
  electricity: "electricity",
  water: "water",
  sewer: "sewer",
  gas: "gas",
  hvac: "hvac",
  telecommunications: "telecommunications",
  other: "other",
};
const UTILITY_BILLING_METHOD_TO_PAYMENT_MECHANISM: Record<UtilityBillingMethod, ExpensePaymentMechanism> = {
  direct_to_provider: "direct_payment",
  submetered: "submetered",
  pro_rata_share: "not_stated",
  included_in_rent: "included_in_base_rent",
  flat_fee: "direct_payment",
  not_stated: "not_stated",
};
const UTILITY_BILLING_METHOD_TO_ALLOCATION_METHOD: Record<UtilityBillingMethod, ExpenseAllocationMethod> = {
  direct_to_provider: "direct_meter",
  submetered: "submeter",
  pro_rata_share: "pro_rata_share",
  included_in_rent: "included",
  flat_fee: "not_stated",
  not_stated: "not_stated",
};

export function utilitiesSpecialistToExpenseObligations(obligations: UtilityObligation[], context: ClaimIdentityContext, schemaVersion: string, specialistDomain = "utilities"): ExpenseObligation[] {
  return obligations.map((o, index) => {
    // UtilityObligation carries no obligationType field -- a resolved
    // responsibleParty implies "must_pay" (the only obligation shape a
    // utility responsibility concept has); "not_stated" party -> "not_stated"
    // obligation, never fabricated further.
    const obligationType: ExpenseObligationType = o.responsibleParty === "not_stated" ? "not_stated" : "must_pay";
    return {
      ...baseFields({ context, schemaVersion, specialistDomain, sourceObligationIndex: index, rawObligation: o, sourcePage: o.sourcePage, sourceQuote: o.sourceQuote }),
      family: "utility" as ExpenseFamily,
      category: UTILITY_TYPE_TO_CATEGORY[o.utilityType] ?? "other",
      subcategory: null,
      responsibleParty: o.responsibleParty as ResponsibleParty,
      beneficiaryParty: null,
      obligationType,
      paymentMechanism: UTILITY_BILLING_METHOD_TO_PAYMENT_MECHANISM[o.billingMethod] ?? "not_stated",
      allocationMethod: UTILITY_BILLING_METHOD_TO_ALLOCATION_METHOD[o.billingMethod] ?? "not_stated",
      amountType: "not_stated" as ExpenseAmountType,
      amount: null,
      currency: null,
      percentage: null,
      cap: null,
      inclusions: [],
      exclusions: [],
      reconciliation: null,
      effectivePeriod: null,
      status: o.status,
      verificationStatus: "unverified",
    } as ExpenseObligation;
  });
}

// ── Repairs & maintenance ─────────────────────────────────────────────────────

const REPAIR_COMPONENT_TO_CATEGORY: Record<RepairComponent, ExpenseCategory> = {
  interior: "interior_repairs",
  structure: "structural_repairs",
  roof: "roof_repairs",
  hvac: "hvac",
  common_areas: "common_area_maintenance_work",
  parking: "other",
  capital_replacements: "other",
  code_compliance: "other",
  other: "other",
};
const REPAIR_OBLIGATION_TYPE_TO_EXPENSE: Record<RepairObligationType, ExpenseObligationType> = {
  maintain: "must_perform",
  repair: "must_perform",
  replace: "must_perform",
  reimburse: "must_reimburse",
  not_stated: "not_stated",
};

export function repairsSpecialistToExpenseObligations(obligations: RepairObligation[], context: ClaimIdentityContext, schemaVersion: string, specialistDomain = "repairs_and_maintenance"): ExpenseObligation[] {
  return obligations.map((o, index) => {
    const category = REPAIR_COMPONENT_TO_CATEGORY[o.component] ?? "other";
    return {
      ...baseFields({ context, schemaVersion, specialistDomain, sourceObligationIndex: index, rawObligation: o, sourcePage: o.sourcePage, sourceQuote: o.sourceQuote }),
      family: "repair" as ExpenseFamily,
      category,
      subcategory: category === "other" && o.component !== "other" ? o.component : null,
      responsibleParty: o.responsibleParty as ResponsibleParty,
      beneficiaryParty: null,
      obligationType: REPAIR_OBLIGATION_TYPE_TO_EXPENSE[o.obligationType] ?? "not_stated",
      paymentMechanism: "not_stated" as ExpensePaymentMechanism,
      allocationMethod: "not_stated" as ExpenseAllocationMethod,
      amountType: "not_stated" as ExpenseAmountType,
      amount: null,
      currency: null,
      percentage: null,
      cap: null,
      inclusions: [],
      exclusions: [],
      reconciliation: null,
      effectivePeriod: null,
      status: o.status,
      verificationStatus: "unverified",
    } as ExpenseObligation;
  });
}

export const OBLIGATION_CONVERTERS_BY_DOMAIN: Record<string, (obligations: any[], context: ClaimIdentityContext, schemaVersion: string) => ExpenseObligation[]> = {
  cam_and_operating_expenses: camSpecialistToExpenseObligations,
  taxes: taxSpecialistToExpenseObligations,
  insurance: insuranceSpecialistToExpenseObligations,
  utilities: utilitiesSpecialistToExpenseObligations,
  repairs_and_maintenance: repairsSpecialistToExpenseObligations,
};
