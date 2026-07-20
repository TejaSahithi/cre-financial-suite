// @ts-nocheck
import { makeFinancialFieldProjection, statusToProjectionStatus, statusToValueOrigin } from "./financial-field-projector.ts";

const DATE_FIELD_KEYS: Record<string, string> = {
  lease_date: "lease_date",
  effective_date: "lease_date",
  execution_date: "lease_date",
  commencement_date: "commencement_date",
  start_date: "start_date",
  expiration_date: "expiration_date",
  end_date: "end_date",
  rent_commencement_date: "rent_commencement_date",
  assignment_effective_date: "assignment_effective_date",
  option_exercise_deadline: "option_exercise_deadline",
  tenant_signature_date: "tenant_signature_date",
  landlord_signature_date: "landlord_signature_date",
};

export function dateResultsToFieldProjections(results: any[] = []) {
  return results.map((result) => {
    const conceptKey = DATE_FIELD_KEYS[result.conceptKey] ?? result.conceptKey;
    const hasValue = !!result.resolvedDate;
    const projectionStatus = statusToProjectionStatus(result.resolutionStatus, hasValue);
    const valueOrigin = statusToValueOrigin(result.resolutionStatus);
    return makeFinancialFieldProjection({
      fieldKey: conceptKey,
      conceptKey,
      projectionStatus,
      valueOrigin,
      normalizedValue: projectionStatus === "available" ? result.resolvedDate : null,
      displayValue: projectionStatus === "available" ? result.resolvedDate : null,
      sourceClaimId: result.sourceClaimIds?.[0] ?? null,
      sourceDateExpressionId: result.dateExpressionId ?? null,
      sourceCalculationResultId: result.id ?? result.dateResolutionResultId ?? null,
      validationCodes: result.validationCodes ?? [],
      formulaKey: result.formulaKey ?? null,
      formulaVersion: result.formulaVersion ?? null,
      assumptions: result.assumptions ?? {},
      evidenceSummary: result.evidenceSummary ?? { source_claim_ids: result.sourceClaimIds ?? [] },
      relatedDocumentRequirementId: result.relatedDocumentRequirementId ?? null,
    });
  });
}
