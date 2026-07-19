// @ts-nocheck
/**
 * P3.5 concept-domain policy.
 *
 * Domains are derived from the P2 concept registry, then narrowed for
 * package-resolution semantics. This is not a second field registry: unknown
 * or dynamic concepts stay lower-authority unless an explicit future policy
 * adds them.
 */

import { getClaimConcept } from "../../claims/concept-registry.ts";

export type PackageConceptDomain =
  | "parties"
  | "assignment"
  | "premises"
  | "term"
  | "rent"
  | "expenses"
  | "cam"
  | "insurance"
  | "utilities"
  | "repairs"
  | "options"
  | "critical_dates"
  | "notices"
  | "signatures"
  | "work"
  | "document"
  | "other"
  | "dynamic";

const ASSIGNMENT_CONCEPTS = new Set([
  "assignee_name",
  "assignor_name",
  "assignment_effective_date",
  "assignment_provisions",
  "assumption_scope",
  "landlord_consent",
  "landlord_consent_for_transfer",
  "assignee_notice_address",
  "security_deposit",
]);

const WORK_CONCEPTS = new Set([
  "ti_allowance",
]);

const TERM_CONCEPTS = new Set([
  "start_date",
  "end_date",
  "commencement_date",
  "expiration_date",
  "rent_commencement_date",
  "lease_date",
  "renewal_options",
  "renewal_type",
  "renewal_notice_months",
  "option_exercise_deadline",
]);

export const BASE_DEPENDENT_CONCEPTS = [
  "monthly_rent",
  "annual_rent",
  "cam_amount",
  "base_year",
  "expense_stop",
  "property_address",
  "property_name",
  "unit_number",
  "square_footage",
  "start_date",
  "end_date",
  "commencement_date",
  "expiration_date",
  "renewal_options",
  "tenant_insurance_required",
];

export function getPackageConceptDomain(conceptKey: string): PackageConceptDomain {
  if (/^dynamic\.guarant/i.test(conceptKey)) return "parties";
  if (conceptKey.startsWith("dynamic.")) return "dynamic";
  if (ASSIGNMENT_CONCEPTS.has(conceptKey)) return "assignment";
  if (WORK_CONCEPTS.has(conceptKey)) return "work";
  if (TERM_CONCEPTS.has(conceptKey)) return "term";

  const concept = getClaimConcept(conceptKey);
  if (!concept) return "other";
  switch (concept.domain) {
    case "parties": return "parties";
    case "premises": return "premises";
    case "rent": return "rent";
    case "expenses": return "expenses";
    case "cam": return "cam";
    case "insurance": return "insurance";
    case "utilities": return "utilities";
    case "repairs": return "repairs";
    case "options": return "options";
    case "critical_dates": return "critical_dates";
    case "notices": return "notices";
    case "signatures": return "signatures";
    case "document": return "document";
    default: return "other";
  }
}

export function isRegisteredAuthoritativeConcept(conceptKey: string): boolean {
  return /^dynamic\.guarant/i.test(conceptKey) || (!conceptKey.startsWith("dynamic.") && Boolean(getClaimConcept(conceptKey)));
}
