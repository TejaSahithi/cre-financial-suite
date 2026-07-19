// @ts-nocheck
import { addDays, addMonths, compareDateOnly } from "./date-only-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_TERM_RESOLUTION_ENGINE_VERSION } from "./calculation-version.ts";

export interface TermCandidateForResolution {
  id: string;
  termType: string;
  instanceKey: string;
  startDateResultId?: string | null;
  endDateResultId?: string | null;
  durationValue?: number | null;
  durationUnit?: "day" | "month" | "year" | null;
  explicitEndDate?: string | null;
  priorTermEndDate?: string | null;
  optionExercised?: boolean;
  sourceClaimIds?: string[];
}

export function resolveLeaseTerm(candidate: TermCandidateForResolution, dateResults: Map<string, any>) {
  const start = candidate.startDateResultId ? dateResults.get(candidate.startDateResultId) : null;
  const end = candidate.endDateResultId ? dateResults.get(candidate.endDateResultId) : null;
  const codes: string[] = [];
  let resolvedStartDate = start?.resolvedDate ?? null;
  let resolvedEndDate = end?.resolvedDate ?? null;
  let status = "resolved";

  if (candidate.termType === "option_term" && !candidate.optionExercised) {
    status = "unresolved";
    codes.push("TERM_OPTION_NOT_EXERCISED");
  }
  if (candidate.termType === "holdover_term") {
    status = "unresolved";
    codes.push("TERM_HOLDOVER_NOT_CONTRACTUAL_EXTENSION");
  }
  if (candidate.priorTermEndDate && !resolvedStartDate && candidate.termType === "extension_term") {
    resolvedStartDate = addDays(candidate.priorTermEndDate, 1);
  }
  if (resolvedStartDate && !resolvedEndDate && candidate.durationValue && candidate.durationUnit) {
    if (candidate.durationUnit === "month") resolvedEndDate = addDays(addMonths(resolvedStartDate, candidate.durationValue), -1);
    else if (candidate.durationUnit === "year") resolvedEndDate = addDays(addMonths(resolvedStartDate, candidate.durationValue * 12), -1);
    else resolvedEndDate = addDays(resolvedStartDate, candidate.durationValue - 1);
    status = status === "resolved" ? "calculated" : status;
  }
  if (!resolvedStartDate || !resolvedEndDate) {
    status = "unresolved";
    codes.push("TERM_REQUIRED_DATE_MISSING");
  }
  if (candidate.explicitEndDate && resolvedEndDate && compareDateOnly(candidate.explicitEndDate, resolvedEndDate) !== 0) {
    status = "needs_review";
    codes.push("TERM_DURATION_CONFLICT");
  }

  return {
    termCandidateId: candidate.id,
    termType: candidate.termType,
    instanceKey: candidate.instanceKey,
    resolutionStatus: status,
    resolvedStartDate: status === "unresolved" ? null : resolvedStartDate,
    resolvedEndDate: status === "unresolved" ? null : resolvedEndDate,
    resolvedDurationValue: candidate.durationValue ?? null,
    resolvedDurationUnit: candidate.durationUnit ?? null,
    startDateResultId: candidate.startDateResultId ?? null,
    endDateResultId: candidate.endDateResultId ?? null,
    formulaKey: candidate.durationValue ? "term.duration.inclusive:v1" : null,
    formulaVersion: "lease-term-candidates-v1",
    validationStatus: codes.length ? (status === "needs_review" ? "needs_review" : "unresolved") : "valid",
    validationCodes: codes,
    provenance: defaultCalculationProvenance(LEASE_TERM_RESOLUTION_ENGINE_VERSION, [candidate.startDateResultId, candidate.endDateResultId].filter(Boolean), candidate.sourceClaimIds ?? []),
  };
}
