// @ts-nocheck
/**
 * Phase 6A deterministic UI projection (6A.6, correction F).
 *
 * Tightened well beyond Phase 5's original 4-condition
 * safeExactCanonicalMappingExists (category + responsibleParty-value-only):
 * status/verification/paymentMechanism/obligationType/requiresReview now
 * all gate the decision. This is the concrete mechanism that keeps a
 * property-insurance-included-in-rent obligation from ever producing an
 * insurance_responsibility mapping -- paymentMechanism:"included_in_base_rent"
 * fails meetsSafeMappingBar outright, regardless of what responsibleParty
 * says. Mixed/conditional/unverified/needs-review obligations always fall
 * through to a dynamic-row proposal instead -- never force-collapsed into
 * one coarse field.
 */

import type { ExpenseObligation } from "./expense-obligation.ts";

const SAFE_RESPONSIBLE_PARTY_VALUES = new Set(["tenant", "landlord", "shared"]);

function meetsSafeMappingBar(o: ExpenseObligation): boolean {
  return o.status === "explicit"
    && o.verificationStatus === "verified"
    && o.paymentMechanism !== "included_in_base_rent"
    && o.responsibleParty !== "not_stated"
    && SAFE_RESPONSIBLE_PARTY_VALUES.has(o.responsibleParty)
    && !o.requiresReview;
}

interface MappableConcept {
  targetFieldKey: string;
  matches: (o: ExpenseObligation) => boolean;
  /** obligationType allow-list -- never must_reimburse/may_insure/
   *  included_service, which all describe a weaker or conditional
   *  obligation than a flat responsibility field can honestly represent. */
  allowedObligationTypes: ReadonlySet<string>;
}

const MAPPABLE_CONCEPTS: MappableConcept[] = [
  { targetFieldKey: "electric_responsibility", matches: (o) => o.category === "electricity", allowedObligationTypes: new Set(["must_pay"]) },
  { targetFieldKey: "water_sewer_responsibility", matches: (o) => o.category === "water" || o.category === "sewer", allowedObligationTypes: new Set(["must_pay"]) },
  { targetFieldKey: "responsibility_taxes", matches: (o) => o.category === "real_estate_taxes", allowedObligationTypes: new Set(["must_pay"]) },
  { targetFieldKey: "insurance_responsibility", matches: (o) => o.category === "property_insurance", allowedObligationTypes: new Set(["must_pay", "must_insure"]) },
];

function findMappableConcept(o: ExpenseObligation): MappableConcept | null {
  for (const concept of MAPPABLE_CONCEPTS) {
    if (concept.matches(o) && concept.allowedObligationTypes.has(o.obligationType)) return concept;
  }
  return null;
}

export function safeExactCanonicalMappingExists(o: ExpenseObligation): boolean {
  return meetsSafeMappingBar(o) && findMappableConcept(o) != null;
}

export interface ExpenseCanonicalMappingProposal {
  targetFieldKey: string;
  value: string;
  sourceObligationId: string;
}

export function proposeCanonicalMapping(o: ExpenseObligation): ExpenseCanonicalMappingProposal | null {
  if (!safeExactCanonicalMappingExists(o)) return null;
  const concept = findMappableConcept(o);
  if (!concept) return null;
  return { targetFieldKey: concept.targetFieldKey, value: o.responsibleParty, sourceObligationId: o.obligationId };
}

export interface ExpenseDynamicRowProposal {
  businessTab: "expenses_recoveries" | "insurance" | "repairs_maintenance" | "utilities";
  label: string;
  value: string;
  sourcePage: number | null;
  sourceQuote: string | null;
  requiresReview: boolean;
  sourceObligationId: string;
}

const FAMILY_TO_BUSINESS_TAB: Record<string, ExpenseDynamicRowProposal["businessTab"]> = {
  cam: "expenses_recoveries",
  fee: "expenses_recoveries",
  tax: "expenses_recoveries",
  insurance: "insurance",
  utility: "utilities",
  repair: "repairs_maintenance",
  other: "expenses_recoveries",
};

function describeObligationValue(o: ExpenseObligation): string {
  const parts: string[] = [];
  if (o.percentage != null) parts.push(`${o.percentage}%`);
  if (o.amount != null) parts.push(String(o.amount));
  if (o.cap) parts.push(`cap: ${o.cap.type}${o.cap.value != null ? ` ${o.cap.value}` : ""}`);
  if (o.responsibleParty !== "not_stated") parts.push(o.responsibleParty);
  if (o.paymentMechanism !== "not_stated") parts.push(o.paymentMechanism);
  return parts.length > 0 ? parts.join(" / ") : o.status;
}

export function proposeDynamicRow(o: ExpenseObligation): ExpenseDynamicRowProposal | null {
  if (o.evidence.length === 0 && o.status === "not_found") return null;
  return {
    businessTab: FAMILY_TO_BUSINESS_TAB[o.family] ?? "expenses_recoveries",
    label: `${o.category}${o.subcategory ? ` (${o.subcategory})` : ""}`,
    value: describeObligationValue(o),
    sourcePage: o.evidence[0]?.pageNumber ?? null,
    sourceQuote: o.evidence[0]?.quote ?? null,
    requiresReview: o.requiresReview,
    sourceObligationId: o.obligationId,
  };
}

export function proposeExpenseObligationPlacements(obligations: ExpenseObligation[]): {
  canonicalMappings: ExpenseCanonicalMappingProposal[];
  dynamicRows: ExpenseDynamicRowProposal[];
} {
  const canonicalMappings: ExpenseCanonicalMappingProposal[] = [];
  const dynamicRows: ExpenseDynamicRowProposal[] = [];
  for (const o of obligations) {
    if (safeExactCanonicalMappingExists(o)) {
      const mapping = proposeCanonicalMapping(o);
      if (mapping) canonicalMappings.push(mapping);
    } else {
      const row = proposeDynamicRow(o);
      if (row) dynamicRows.push(row);
    }
  }
  return { canonicalMappings, dynamicRows };
}
