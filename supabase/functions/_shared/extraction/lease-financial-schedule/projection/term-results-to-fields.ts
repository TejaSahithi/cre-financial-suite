// @ts-nocheck
import { makeFinancialFieldProjection, statusToProjectionStatus, statusToValueOrigin } from "./financial-field-projector.ts";

function termDurationField(result: any) {
  if (!result.resolvedDurationValue) return null;
  if (result.resolvedDurationUnit === "month") return { key: "lease_term_months", value: result.resolvedDurationValue };
  if (result.resolvedDurationUnit === "year") return { key: "lease_term_months", value: Number(result.resolvedDurationValue) * 12 };
  return null;
}

export function termResultsToFieldProjections(results: any[] = []) {
  const out: any[] = [];
  for (const result of results) {
    const status = statusToProjectionStatus(result.resolutionStatus, !!(result.resolvedStartDate || result.resolvedEndDate || result.resolvedDurationValue));
    const origin = statusToValueOrigin(result.resolutionStatus);
    const duration = termDurationField(result);
    if (duration) {
      out.push(makeFinancialFieldProjection({
        fieldKey: duration.key,
        conceptKey: duration.key,
        projectionStatus: status === "available" ? "available" : status,
        valueOrigin: origin,
        normalizedValue: status === "available" ? String(duration.value) : null,
        displayValue: status === "available" ? String(duration.value) : null,
        sourceCalculationResultId: result.id ?? result.termResolutionResultId ?? result.termCandidateId ?? null,
        validationCodes: result.validationCodes ?? [],
        formulaKey: result.formulaKey ?? null,
        formulaVersion: result.formulaVersion ?? null,
        assumptions: result.assumptions ?? {},
        evidenceSummary: result.evidenceSummary ?? { source_claim_ids: result.sourceClaimIds ?? [] },
      }));
    }
    if (result.termType === "initial_term") {
      if (result.resolvedStartDate) out.push(makeFinancialFieldProjection({ fieldKey: "commencement_date", conceptKey: "commencement_date", projectionStatus: "available", valueOrigin: origin, normalizedValue: result.resolvedStartDate, displayValue: result.resolvedStartDate, sourceCalculationResultId: result.id ?? result.termCandidateId ?? null, validationCodes: result.validationCodes ?? [], formulaKey: result.formulaKey ?? null, formulaVersion: result.formulaVersion ?? null, evidenceSummary: result.evidenceSummary ?? {} }));
      if (result.resolvedEndDate) out.push(makeFinancialFieldProjection({ fieldKey: "expiration_date", conceptKey: "expiration_date", projectionStatus: "available", valueOrigin: origin, normalizedValue: result.resolvedEndDate, displayValue: result.resolvedEndDate, sourceCalculationResultId: result.id ?? result.termCandidateId ?? null, validationCodes: result.validationCodes ?? [], formulaKey: result.formulaKey ?? null, formulaVersion: result.formulaVersion ?? null, evidenceSummary: result.evidenceSummary ?? {} }));
    }
    if (["extension_term", "renewal_term", "option_term", "holdover_term"].includes(result.termType)) {
      out.push(makeFinancialFieldProjection({
        fieldKey: `${result.termType}.${result.instanceKey ?? "default"}`,
        compatibilityFieldKey: null,
        conceptKey: "renewal_options",
        projectionStatus: status,
        valueOrigin: result.termType === "option_term" && result.resolutionStatus === "unresolved" ? "unresolved" : origin,
        normalizedValue: status === "available" ? { startDate: result.resolvedStartDate, endDate: result.resolvedEndDate, termType: result.termType } : null,
        displayValue: status === "available" ? `${result.termType}: ${result.resolvedStartDate ?? "?"} - ${result.resolvedEndDate ?? "?"}` : null,
        sourceCalculationResultId: result.id ?? result.termCandidateId ?? null,
        validationCodes: result.validationCodes ?? [],
        formulaKey: result.formulaKey ?? null,
        formulaVersion: result.formulaVersion ?? null,
        evidenceSummary: result.evidenceSummary ?? {},
        internalOnly: true,
      }));
    }
  }
  return out;
}
