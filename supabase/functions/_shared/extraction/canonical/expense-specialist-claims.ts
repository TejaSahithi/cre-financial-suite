// @ts-nocheck
/**
 * Phase 5 expense-specialist obligation -> canonical claim conversion.
 *
 * Each obligation instance (a CamObligation/TaxObligation/InsuranceObligation/
 * UtilityObligation/RepairObligation returned by an ExpenseSpecialistShadowRecord)
 * produces SEVERAL sub-field claims -- one per meaningful property -- since
 * the strict schemas describe multi-property concepts, not flat fields.
 * Every sub-claim of one obligation instance shares that instance's single
 * evidence pair (sourcePage/sourceQuote) -- the strict schemas only capture
 * one quote per whole obligation, not per sub-field; that is an honest
 * limitation of the source shape, not a design choice here (same caveat
 * claim-converters.ts's mapperResultToClaims documents for FieldAssignment).
 *
 * fieldCode format: "<namespace>.<disambiguating-category>.<subfield>", e.g.
 * "expense.cam.common_area_maintenance.responsible_party",
 * "insurance.tenant_property.obligated_party",
 * "expense.utility.electricity.responsible_party",
 * "repair.roof.responsible_party" -- the disambiguating category segment is
 * included for EVERY type (not just the ones the original spec's examples
 * showed it for) since every obligation type can legitimately produce
 * multiple obligations per specialist call (e.g. 4 separate utilities) --
 * omitting it would let same-named sub-fields from different obligation
 * instances collide on one fieldCode.
 *
 * Diagnostics-only in this phase (per the Phase 5 plan): neither
 * proposeCanonicalMapping nor proposeDynamicRow writes into
 * ui_review_payload or any authoritative field -- both only produce
 * inspectable claim/row shapes for a human (or a later phase) to review.
 */

import { resolveCanonicalKey } from "../field-contract.ts";
import { applyEvidenceVerification } from "./claim-validation.ts";
import type { ExtractedClaim } from "./extracted-claim.ts";
import type { EvidenceReference } from "./evidence-reference.ts";
import type { ClaimIdentityContext } from "./claim-converters.ts";
import type { ExpenseSpecialistShadowRecord } from "../openai-fact-ledger/expense-specialist-shadow.ts";

function newClaimId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `claim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function obligationEvidence(fileId: string, obligation: any): EvidenceReference[] {
  if (!obligation.sourceQuote) return [];
  return [{ documentId: fileId, pageNumber: obligation.sourcePage ?? null, nodeId: null, quote: obligation.sourceQuote, polygon: null, ocrConfidence: null, role: "direct" }];
}

/** obligation.status ("explicit"/"derived"/"ambiguous"/"conflicting"/"not_found")
 *  maps directly onto ClaimStatus -- both vocabularies were deliberately
 *  kept aligned when the obligation schemas were designed (cam-obligation.schema.ts). */
function obligationClaimStatus(obligation: any): ExtractedClaim["status"] {
  return obligation.status ?? "not_found";
}

interface ObligationClaimSpec {
  /** e.g. "expense.cam", "insurance", "expense.utility", "expense.tax", "repair" */
  fieldPrefix: string;
  /** Which obligation property supplies the disambiguating segment, e.g. "category" / "coverageType" / "utilityType" / "component". */
  categoryKey: string;
  /** Which obligation properties each become their own sub-claim. */
  subfieldKeys: string[];
}

function obligationsToClaims(
  obligations: any[],
  spec: ObligationClaimSpec,
  domain: string,
  context: ClaimIdentityContext,
  schemaVersion: string,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const obligation of obligations) {
    const category = String(obligation[spec.categoryKey] ?? "unspecified");
    const evidence = obligationEvidence(context.fileId, obligation);
    const status = obligationClaimStatus(obligation);
    for (const subfieldKey of spec.subfieldKeys) {
      const value = obligation[subfieldKey];
      if (value === undefined) continue;
      const fieldCode = `${spec.fieldPrefix}.${category}.${subfieldKey}`;
      claims.push({
        claimId: newClaimId(),
        organizationId: context.organizationId,
        fileId: context.fileId,
        generationId: context.generationId,
        extractionRunId: context.extractionRunId,
        domain,
        fieldCode,
        canonicalFieldCode: resolveCanonicalKey(fieldCode),
        status,
        verificationStatus: "unverified",
        rawValue: value != null ? String(value) : null,
        normalizedValue: value ?? null,
        evidence,
        controllingDocumentId: null,
        sourceModel: "llm",
        promptVersion: null,
        schemaVersion,
        requiresReview: status === "ambiguous" || status === "conflicting",
        reviewReasons: [],
        createdAt: new Date().toISOString(),
      });
    }
  }
  return claims;
}

export function camObligationsToClaims(obligations: any[], context: ClaimIdentityContext, schemaVersion: string): ExtractedClaim[] {
  return obligationsToClaims(
    obligations,
    {
      fieldPrefix: "expense.cam",
      categoryKey: "category",
      subfieldKeys: ["responsibleParty", "paymentMechanism", "allocationMethod", "amountType", "amount", "percentage", "cap", "inclusions", "exclusions", "reconciliationFrequency", "auditRight"],
    },
    "cam_and_operating_expenses", context, schemaVersion,
  );
}

export function taxObligationsToClaims(obligations: any[], context: ClaimIdentityContext, schemaVersion: string): ExtractedClaim[] {
  return obligationsToClaims(
    obligations,
    { fieldPrefix: "expense.tax", categoryKey: "category", subfieldKeys: ["responsibleParty", "economicTreatment", "baseYear", "capOrLimit"] },
    "taxes", context, schemaVersion,
  );
}

export function insuranceObligationsToClaims(obligations: any[], context: ClaimIdentityContext, schemaVersion: string): ExtractedClaim[] {
  return obligationsToClaims(
    obligations,
    { fieldPrefix: "insurance", categoryKey: "coverageType", subfieldKeys: ["obligatedParty", "obligationType", "economicTreatment"] },
    "insurance", context, schemaVersion,
  );
}

export function utilityObligationsToClaims(obligations: any[], context: ClaimIdentityContext, schemaVersion: string): ExtractedClaim[] {
  return obligationsToClaims(
    obligations,
    { fieldPrefix: "expense.utility", categoryKey: "utilityType", subfieldKeys: ["responsibleParty", "billingMethod"] },
    "utilities", context, schemaVersion,
  );
}

export function repairObligationsToClaims(obligations: any[], context: ClaimIdentityContext, schemaVersion: string): ExtractedClaim[] {
  return obligationsToClaims(
    obligations,
    { fieldPrefix: "repair", categoryKey: "component", subfieldKeys: ["responsibleParty", "obligationType"] },
    "repairs_and_maintenance", context, schemaVersion,
  );
}

const OBLIGATION_CONVERTERS: Record<string, (obligations: any[], context: ClaimIdentityContext, schemaVersion: string) => ExtractedClaim[]> = {
  cam_and_operating_expenses: camObligationsToClaims,
  taxes: taxObligationsToClaims,
  insurance: insuranceObligationsToClaims,
  utilities: utilityObligationsToClaims,
  repairs_and_maintenance: repairObligationsToClaims,
};

/**
 * Converts every "success"-status shadow record's obligations into claims,
 * then runs evidence verification (applyEvidenceVerification -- same
 * Phase-2 function the rest of the canonical layer uses; no second
 * verification mechanism). Records with any other technicalStatus
 * contribute zero claims (nothing to convert).
 */
export function expenseSpecialistRecordsToClaims(
  records: ExpenseSpecialistShadowRecord[],
  context: ClaimIdentityContext,
  doclingRaw: Record<string, unknown> | null,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const record of records) {
    if (record.technicalStatus !== "success") continue;
    const converter = OBLIGATION_CONVERTERS[record.domain];
    if (!converter) continue;
    claims.push(...converter(record.obligations, context, record.schemaVersion));
  }
  return claims.map((claim) => applyEvidenceVerification(claim, doclingRaw));
}

// ── Mapping policy: safe exact canonical mapping vs dynamic row ─────────────
//
// Checked every plausible existing UI field this session's schema (schemas.ts)
// already has for these concepts (electric_responsibility, water_sewer_responsibility,
// tax_responsibility/responsibility_taxes, insurance_responsibility/
// property_insurance_responsibility, responsibility_repairs, cam_cap_type/
// cam_cap_pct). Two real constraints kept nearly everything OUT of "safe":
//  1. Vocabulary mismatch -- e.g. CamObligationCap.type's enum
//     (cumulative_percentage/non_cumulative_percentage/fixed_amount/other)
//     does not line up with cam_cap_type's (cumulative/non_cumulative/
//     compounding/none); mapping without a real translation layer would
//     silently misrepresent the value, which this phase deliberately does
//     not attempt to build.
//  2. Granularity loss -- responsibility_repairs is ONE flat field, but
//     RepairObligation is specifically designed to return MULTIPLE
//     per-component obligations; collapsing them back into one field would
//     regress exactly the problem this specialist exists to fix. Same
//     reasoning excludes CAM (multiple categories per call) from any
//     canonical mapping.
// What's left as genuinely safe: a SINGLE utility/tax/insurance obligation
// whose responsibleParty/obligatedParty is one of the 3 values the legacy
// field's own vocabulary was built for (tenant/landlord/shared) -- "mixed"/
// "conditional"/"not_stated" are new, more precise answers this specialist
// can produce that the legacy field has no slot for, so those stay
// dynamic-row proposals rather than being force-fit.

const SAFE_RESPONSIBLE_PARTY_VALUES = new Set(["tenant", "landlord", "shared"]);

export interface CanonicalMappingProposal {
  targetFieldKey: string;
  value: unknown;
  sourceClaimId: string;
}

export function safeExactCanonicalMappingExists(claim: ExtractedClaim): boolean {
  if (!SAFE_RESPONSIBLE_PARTY_VALUES.has(String(claim.normalizedValue))) return false;
  if (claim.fieldCode.endsWith(".electricity.responsibleParty")) return true;
  if ((claim.fieldCode.includes(".water.") || claim.fieldCode.includes(".sewer.")) && claim.fieldCode.endsWith(".responsibleParty")) return true;
  if (claim.fieldCode.startsWith("expense.tax.real_estate_tax.") && claim.fieldCode.endsWith(".responsibleParty")) return true;
  if (claim.fieldCode.startsWith("insurance.building.") && claim.fieldCode.endsWith(".obligatedParty")) return true;
  return false;
}

export function proposeCanonicalMapping(claim: ExtractedClaim): CanonicalMappingProposal | null {
  if (!safeExactCanonicalMappingExists(claim)) return null;
  let targetFieldKey: string | null = null;
  if (claim.fieldCode.endsWith(".electricity.responsibleParty")) targetFieldKey = "electric_responsibility";
  else if ((claim.fieldCode.includes(".water.") || claim.fieldCode.includes(".sewer.")) && claim.fieldCode.endsWith(".responsibleParty")) targetFieldKey = "water_sewer_responsibility";
  else if (claim.fieldCode.startsWith("expense.tax.real_estate_tax.")) targetFieldKey = "responsibility_taxes";
  else if (claim.fieldCode.startsWith("insurance.building.")) targetFieldKey = "insurance_responsibility";
  if (!targetFieldKey) return null;
  return { targetFieldKey, value: claim.normalizedValue, sourceClaimId: claim.claimId };
}

// Deliberately NOT claim-converters.ts's claimsToDynamicRows() here --
// that function's return shape (a full createDocumentItem() document-item
// row, matching dynamicFields.js's frontend contract) doesn't match this
// lighter SpecialistDynamicRowProposal shape at all. This is Phase 5's own
// diagnostics-only proposal shape; wiring these into a real dynamic row
// (via claimsToDynamicRows or otherwise) is a later, separate promotion
// step, not this phase's concern.
export interface SpecialistDynamicRowProposal {
  businessTab: "expenses_recoveries" | "insurance" | "repairs_maintenance" | "utilities";
  label: string;
  value: string;
  sourcePage: number | null;
  sourceQuote: string | null;
  requiresReview: boolean;
  reviewReason: string | null;
  sourceClaimIds: string[];
}

const DOMAIN_TO_BUSINESS_TAB: Record<string, SpecialistDynamicRowProposal["businessTab"]> = {
  cam_and_operating_expenses: "expenses_recoveries",
  taxes: "expenses_recoveries",
  insurance: "insurance",
  utilities: "utilities",
  repairs_and_maintenance: "repairs_maintenance",
};

export function proposeDynamicRow(claim: ExtractedClaim): SpecialistDynamicRowProposal | null {
  if (claim.normalizedValue == null) return null;
  const businessTab = DOMAIN_TO_BUSINESS_TAB[claim.domain] ?? "expenses_recoveries";
  return {
    businessTab,
    label: claim.fieldCode,
    value: typeof claim.normalizedValue === "string" ? claim.normalizedValue : JSON.stringify(claim.normalizedValue),
    sourcePage: claim.evidence[0]?.pageNumber ?? null,
    sourceQuote: claim.evidence[0]?.quote ?? null,
    requiresReview: claim.requiresReview,
    reviewReason: claim.reviewReasons[0] ?? null,
    sourceClaimIds: [claim.claimId],
  };
}

/** Applies the mapping policy verbatim: safeExactCanonicalMappingExists ->
 *  proposeCanonicalMapping, else proposeDynamicRow. Both diagnostics-only
 *  in this phase -- neither is published anywhere. */
export function proposeClaimPlacements(claims: ExtractedClaim[]): {
  canonicalMappings: CanonicalMappingProposal[];
  dynamicRows: SpecialistDynamicRowProposal[];
} {
  const canonicalMappings: CanonicalMappingProposal[] = [];
  const dynamicRows: SpecialistDynamicRowProposal[] = [];
  for (const claim of claims) {
    if (safeExactCanonicalMappingExists(claim)) {
      const mapping = proposeCanonicalMapping(claim);
      if (mapping) canonicalMappings.push(mapping);
    } else {
      const row = proposeDynamicRow(claim);
      if (row) dynamicRows.push(row);
    }
  }
  return { canonicalMappings, dynamicRows };
}
