// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-E: the
// shadow/validation harness's variance classifier. Pure function — takes a
// V1 figure and a V2 figure for the same (lease, metric) and classifies
// the difference, it does not compute either figure itself.
//
// V1 parity is explicitly NOT the acceptance standard (per the Phase 3B
// instructions) — V1 (cam-calculator.ts) has known, documented defects
// (leap-year 365-day hardcode, non-time-weighted occupied area, gross-up
// keyed off `controllable` not cost-behavior, base-year+stop additive
// rather than alternative, only non_cumulative caps implemented, no
// rounding-residual reconciliation — see the Phase 3 report). A variance
// is therefore EXPECTED and, in most cases, evidence V2 is correct where
// V1 was wrong — this classifier exists to make that distinction legible
// per-case, not to drive toward "V1 == V2."
export type VarianceClassification =
  | "EXPECTED_V2_CORRECTION"
  | "SOURCE_DATA_MAPPING_DIFFERENCE"
  | "CONFIGURATION_DIFFERENCE"
  | "ROUNDING_DIFFERENCE"
  | "UNSUPPORTED_RULE"
  | "POSSIBLE_ENGINE_DEFECT";

export interface VarianceInput {
  leaseId: string;
  metric: "pool_total" | "lease_share" | "final_recovery" | "estimates_billed" | "amount_due_credit";
  v1Value: number;
  v2Value: number;
  // Known V1 defects this specific comparison could be explained by --
  // supplied by the caller (the shadow runner knows which V1 code paths
  // were actually exercised for this property/lease, this module doesn't
  // re-derive it from nothing).
  context: {
    leapYearInPeriod?: boolean;
    hasVacancy?: boolean;
    hasGrossUp?: boolean;
    hasBaseYearAndStop?: boolean;
    capType?: "non_cumulative" | "cumulative" | "fixed_dollar" | "other" | null;
    hasDirectExpenseCapExempt?: boolean;
    v2HasUnsupportedRuleException?: boolean; // e.g. UNRECOGNIZED_POLICY_STEP
  };
}

export interface VarianceResult {
  leaseId: string;
  metric: VarianceInput["metric"];
  v1Value: number;
  v2Value: number;
  delta: number;
  deltaPct: number | null;
  classification: VarianceClassification;
  explanation: string;
}

const ROUNDING_TOLERANCE = 0.01; // one cent

export function classifyVariance(input: VarianceInput): VarianceResult {
  const delta = round2(input.v2Value - input.v1Value);
  const deltaPct = input.v1Value !== 0 ? round4(delta / input.v1Value) : null;
  const { context } = input;

  let classification: VarianceClassification;
  let explanation: string;

  if (Math.abs(delta) <= ROUNDING_TOLERANCE) {
    classification = "ROUNDING_DIFFERENCE";
    explanation = `Delta ${delta} is within the one-cent rounding tolerance.`;
  } else if (context.v2HasUnsupportedRuleException) {
    classification = "UNSUPPORTED_RULE";
    explanation = "V2 raised a blocking exception for a policy step it does not (yet) support -- the variance reflects an incomplete V2 rule mapping, not a V1/V2 disagreement on a rule both engines implement.";
  } else if (context.leapYearInPeriod) {
    classification = "EXPECTED_V2_CORRECTION";
    explanation = "The recovery period includes a leap year. V1 always divides by a hardcoded 365 (cam-calculator.ts normalizeLeaseState); V2 uses the real calendar day count. A variance here is V1's known defect, not a V2 regression.";
  } else if (context.hasVacancy && context.hasGrossUp) {
    classification = "EXPECTED_V2_CORRECTION";
    explanation = "V1 does not time-weight occupied area for gross-up (cam-calculator.ts buildPoolMetrics sums full leased_sqft of active leases without day-weighting turnover); V2 does. A variance during a vacancy/turnover period is expected.";
  } else if (context.hasBaseYearAndStop) {
    classification = "EXPECTED_V2_CORRECTION";
    explanation = "V1 adds base-year and expense-stop deductions together as if both apply simultaneously (cam-calculator.ts applyBaseYearAndStops); the blueprint requires them to be separate, non-additive methods unless a policy step explicitly composes both. A variance here reflects that architectural fix, not a defect.";
  } else if (context.capType === "cumulative" || context.capType === "other") {
    classification = "EXPECTED_V2_CORRECTION";
    explanation = `V1 only implements real logic for cap_type='non_cumulative' (cam-calculator.ts:1020-1108); any other cap type falls back to a prior-year baseline with no real compounding/banking. V2 implements cumulative/fixed_dollar/category-specific caps for real -- a variance for cap_type='${context.capType}' is expected.`;
  } else if (context.hasDirectExpenseCapExempt) {
    classification = "EXPECTED_V2_CORRECTION";
    explanation = "V1 parses direct_expense_cap_exempt but never uses it in any calculation; V2 honors it via DIRECT_ASSIGN bypassing the cap entirely. A variance here is V1 silently ignoring a configured exemption.";
  } else {
    // No known V1 defect explains this variance -- either a genuine source-
    // data mapping difference (the two engines read different tables for
    // the same fact) or a real V2 engine defect. This classifier cannot
    // distinguish those two without a human reviewing the specific
    // calculation lines; it deliberately does NOT guess between them.
    classification = "POSSIBLE_ENGINE_DEFECT";
    explanation = `No known V1 defect or configuration difference explains this ${input.metric} variance of ${delta} (${deltaPct !== null ? (deltaPct * 100).toFixed(2) + "%" : "n/a"}) for lease ${input.leaseId} -- requires manual review of both engines' calculation lines. Could also be SOURCE_DATA_MAPPING_DIFFERENCE if V1 and V2 read the fact from different source tables; that reclassification requires confirming the source data, not just the numbers.`;
  }

  return { leaseId: input.leaseId, metric: input.metric, v1Value: input.v1Value, v2Value: input.v2Value, delta, deltaPct, classification, explanation };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
