// @ts-nocheck
import { makeFinancialFieldProjection } from "./financial-field-projector.ts";
import { buildProjectedScheduleKey } from "./financial-projection-key.ts";

function statusFor(result: any) {
  if (result.resultStatus === "mismatch" || result.validationStatus === "needs_review") return "needs_review";
  if (result.resultStatus === "unresolved" || result.validationStatus === "unresolved") return "unresolved";
  return "available";
}

function originFor(result: any) {
  if (result.resultStatus === "mismatch") return "stated_calculated_mismatch";
  if (result.resultStatus === "reconciled" || (result.statedAmount && result.calculatedAmount && result.validationStatus === "valid")) return "stated_and_validated";
  if (result.calculatedAmount) return "calculated";
  if (result.statedAmount) return "extracted";
  return "unresolved";
}

function chargeFieldKey(result: any): string | null {
  const role = result.chargeRole ?? result.chargeType ?? result.amountRole ?? "";
  if (/security_deposit|deposit/i.test(role)) return "security_deposit";
  if (/tenant_improvement|ti_allowance|allowance/i.test(role)) return "ti_allowance";
  if (/late_fee/i.test(role)) return "late_fee_amount";
  if (/assignment_consideration/i.test(role)) return "assignment_consideration";
  return null;
}

export function chargeResultsToFieldProjections(results: any[] = []) {
  return results.flatMap((result) => {
    const fieldKey = chargeFieldKey(result);
    if (!fieldKey) return [];
    const status = statusFor(result);
    return [makeFinancialFieldProjection({
      fieldKey,
      conceptKey: fieldKey,
      projectionStatus: status,
      valueOrigin: originFor(result),
      normalizedValue: status === "available" ? result.calculatedAmount ?? result.statedAmount ?? null : null,
      displayValue: status === "available" ? String(result.calculatedAmount ?? result.statedAmount ?? "") : null,
      sourceCalculationResultId: result.id ?? result.chargeCalculationResultId ?? null,
      statedSourceResultId: result.statedSourceResultId ?? null,
      calculatedSourceResultId: result.calculatedSourceResultId ?? null,
      validationCodes: result.validationCodes ?? [],
      formulaKey: result.formulaKey ?? result.formulaType ?? null,
      formulaVersion: result.formulaVersion ?? null,
      assumptions: result.assumptions ?? {},
      roundingPolicy: result.roundingPolicy ?? null,
      evidenceSummary: result.evidenceSummary ?? { source_amount_ids: result.sourceAmountIds ?? [] },
      amountRole: result.amountRole ?? result.chargeRole ?? null,
    })];
  });
}

export function chargeResultsToScheduleProjections(results: any[] = []) {
  return results.map((result, index) => {
    const role = result.chargeRole ?? result.chargeType ?? result.amountRole ?? "additional_charge";
    let scheduleType = "additional_charge_period";
    if (/deposit/i.test(role)) scheduleType = "deposit_component";
    if (/allowance|contribution|reimbursement/i.test(role)) scheduleType = "allowance";
    if (/amort/i.test(role)) scheduleType = "amortized_charge";
    return {
      scheduleType,
      scheduleKey: buildProjectedScheduleKey({ scheduleType, sourceId: result.id ?? result.chargeCalculationResultId, sequenceNumber: result.sequenceNumber ?? index + 1, amountRole: role }),
      scheduleStatus: statusFor(result),
      sourceScheduleCandidateId: result.sourceScheduleCandidateId ?? result.chargeCandidateId ?? null,
      sourceCalculationResultId: result.id ?? result.chargeCalculationResultId ?? null,
      sequenceNumber: result.sequenceNumber ?? index + 1,
      startDate: result.startDate ?? null,
      endDate: result.endDate ?? null,
      startTermMonth: result.startTermMonth ?? null,
      endTermMonth: result.endTermMonth ?? null,
      amountRole: role,
      amount: result.calculatedAmount ?? result.statedAmount ?? null,
      currencyCode: result.currencyCode ?? "USD",
      frequency: result.frequency ?? null,
      billingStatus: result.billingStatus ?? (result.estimate ? "estimate" : null),
      valueOrigin: originFor(result),
      formulaKey: result.formulaKey ?? result.formulaType ?? null,
      validationCodes: result.validationCodes ?? [],
      conflictId: result.conflictId ?? null,
    };
  });
}
