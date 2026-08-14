export interface InsuranceRequirementInput {
  lease_id?: string | null;
  minimumLimits?: Record<string, number | string | null> | null;
  additionalInsuredRequired?: boolean | null;
  waiverOfSubrogationRequired?: boolean | null;
}

export interface CoiDocumentInput {
  id?: string | null;
  status?: string | null;
  expiration_date?: string | null;
  coverage_limits?: Record<string, number | string | null> | null;
  additional_insureds?: unknown[] | null;
  waiver_of_subrogation?: boolean | null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateCoiCompliance(input: {
  requirement: InsuranceRequirementInput | null;
  coi: CoiDocumentInput | null;
  asOfDate: string;
}) {
  const reasonCodes: string[] = [];
  if (!input.requirement) reasonCodes.push("INSURANCE_REQUIREMENT_REQUIRED");
  if (!input.coi) reasonCodes.push("COI_DOCUMENT_REQUIRED");
  if (reasonCodes.length > 0) return { status: "blocked", reasonCodes };

  const requirement = input.requirement!;
  const coi = input.coi!;
  if (String(coi.status || "").toLowerCase() !== "approved") reasonCodes.push("COI_NOT_APPROVED");
  if (!coi.expiration_date) reasonCodes.push("COI_EXPIRATION_REQUIRED");
  if (coi.expiration_date && coi.expiration_date < input.asOfDate) reasonCodes.push("COI_EXPIRED");

  const minimumLimits = requirement.minimumLimits ?? {};
  const coverageLimits = coi.coverage_limits ?? {};
  for (const [coverage, requiredValue] of Object.entries(minimumLimits)) {
    const required = asNumber(requiredValue);
    if (required == null) continue;
    const actual = asNumber(coverageLimits[coverage]);
    if (actual == null) reasonCodes.push(`COI_LIMIT_MISSING:${coverage}`);
    else if (actual < required) reasonCodes.push(`COI_LIMIT_BELOW_REQUIREMENT:${coverage}`);
  }

  if (requirement.additionalInsuredRequired && (!Array.isArray(coi.additional_insureds) || coi.additional_insureds.length === 0)) {
    reasonCodes.push("ADDITIONAL_INSURED_REQUIRED");
  }
  if (requirement.waiverOfSubrogationRequired && coi.waiver_of_subrogation !== true) {
    reasonCodes.push("WAIVER_OF_SUBROGATION_REQUIRED");
  }

  const expired = reasonCodes.includes("COI_EXPIRED");
  return {
    status: expired ? "expired" : reasonCodes.length > 0 ? "needs_review" : "compliant",
    reasonCodes,
  };
}