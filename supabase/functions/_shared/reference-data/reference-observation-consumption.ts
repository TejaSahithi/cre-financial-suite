import { createLeaseChargeResult, type LeaseChargeResult } from "../lease-charges/contracts/lease-charge-result.ts";

export interface ReferenceObservationRow {
  id?: string | null;
  org_id?: string | null;
  provider?: string | null;
  series_id?: string | null;
  period?: string | null;
  value?: number | string | null;
  retrieved_at?: string | null;
  source_url?: string | null;
  payload_fingerprint?: string | null;
  status?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
}

export interface FrozenReferenceObservation {
  observationId: string;
  provider: string;
  providerSeriesId: string;
  period: string;
  value: number;
  retrievedAt: string;
  approvedAt: string;
  approvedBy: string | null;
  sourceUrl: string | null;
  payloadFingerprint: string | null;
}

export interface ReferenceObservationSelectionRequest {
  orgId?: string | null;
  provider?: string | null;
  seriesId?: string | null;
  period?: string | null;
}

export type ReferenceObservationSelection =
  | { ok: true; observation: FrozenReferenceObservation; reasonCodes: [] }
  | { ok: false; observation: null; reasonCodes: string[] };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedProvider(value: unknown): string {
  return clean(value).toLowerCase();
}

export function freezeApprovedReferenceObservation(row: ReferenceObservationRow | null | undefined): ReferenceObservationSelection {
  if (!row) {
    return { ok: false, observation: null, reasonCodes: ["REFERENCE_OBSERVATION_REQUIRED"] };
  }

  const value = numberOrNull(row.value);
  const required = {
    observationId: clean(row.id),
    provider: normalizedProvider(row.provider),
    providerSeriesId: clean(row.series_id),
    period: clean(row.period),
    retrievedAt: clean(row.retrieved_at),
    approvedAt: clean(row.approved_at),
  };

  const missing = Object.entries(required)
    .filter(([, entry]) => !entry)
    .map(([key]) => key);

  if (value == null) missing.push("value");
  if (missing.length > 0) {
    return {
      ok: false,
      observation: null,
      reasonCodes: missing.map((field) => `REFERENCE_OBSERVATION_${field.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}_REQUIRED`),
    };
  }

  if (clean(row.status).toLowerCase() !== "approved") {
    return { ok: false, observation: null, reasonCodes: ["REFERENCE_OBSERVATION_NOT_APPROVED"] };
  }

  return {
    ok: true,
    observation: {
      observationId: required.observationId,
      provider: required.provider,
      providerSeriesId: required.providerSeriesId,
      period: required.period,
      value: value as number,
      retrievedAt: required.retrievedAt,
      approvedAt: required.approvedAt,
      approvedBy: clean(row.approved_by) || null,
      sourceUrl: clean(row.source_url) || null,
      payloadFingerprint: clean(row.payload_fingerprint) || null,
    },
    reasonCodes: [],
  };
}

export function selectApprovedReferenceObservation(
  rows: ReferenceObservationRow[],
  request: ReferenceObservationSelectionRequest,
): ReferenceObservationSelection {
  const provider = normalizedProvider(request.provider);
  const seriesId = clean(request.seriesId);
  const period = clean(request.period);
  const orgId = clean(request.orgId);

  if (!provider) return { ok: false, observation: null, reasonCodes: ["REFERENCE_PROVIDER_REQUIRED"] };
  if (!seriesId) return { ok: false, observation: null, reasonCodes: ["REFERENCE_SERIES_APPROVAL_REQUIRED"] };
  if (!period) return { ok: false, observation: null, reasonCodes: ["REFERENCE_PERIOD_REQUIRED"] };

  const matches = (rows || []).filter((row) =>
    (!orgId || clean(row.org_id) === orgId) &&
    normalizedProvider(row.provider) === provider &&
    clean(row.series_id) === seriesId &&
    clean(row.period) === period
  );

  if (matches.length === 0) return { ok: false, observation: null, reasonCodes: ["REFERENCE_OBSERVATION_NOT_FOUND"] };
  if (matches.length > 1) return { ok: false, observation: null, reasonCodes: ["REFERENCE_OBSERVATION_DUPLICATE"] };
  return freezeApprovedReferenceObservation(matches[0]);
}

export interface IndexAdjustmentInput {
  chargeType: string;
  leaseId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  baseAmount: number | null;
  baseObservation: FrozenReferenceObservation | null;
  currentObservation: FrozenReferenceObservation | null;
  capPercent?: number | null;
  floorPercent?: number | null;
  existingInputs?: Record<string, unknown>;
  existingEvidence?: unknown[];
  existingCalculationLines?: unknown[];
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function referenceEvidence(label: string, observation: FrozenReferenceObservation) {
  return {
    source_type: "reference_observation",
    label,
    observation_id: observation.observationId,
    provider: observation.provider,
    provider_series_id: observation.providerSeriesId,
    period: observation.period,
    value: observation.value,
    retrieved_at: observation.retrievedAt,
    approved_at: observation.approvedAt,
    approved_by: observation.approvedBy,
    source_url: observation.sourceUrl,
    payload_fingerprint: observation.payloadFingerprint,
  };
}

export function evaluateIndexAdjustedLeaseCharge(input: IndexAdjustmentInput): LeaseChargeResult {
  const baseAmount = numberOrNull(input.baseAmount);
  const evidence = [...(input.existingEvidence || [])];
  const calculationLines = [...(input.existingCalculationLines || [])] as any[];

  if (baseAmount == null) {
    return createLeaseChargeResult({
      chargeType: input.chargeType,
      leaseId: input.leaseId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: "blocked",
      reasonCodes: ["INDEX_ADJUSTMENT_BASE_AMOUNT_REQUIRED"],
      inputs: input.existingInputs || {},
      evidence: evidence as any,
      calculationLines,
    });
  }
  if (!input.baseObservation || !input.currentObservation) {
    return createLeaseChargeResult({
      chargeType: input.chargeType,
      leaseId: input.leaseId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: "blocked",
      reasonCodes: ["APPROVED_REFERENCE_OBSERVATIONS_REQUIRED"],
      inputs: input.existingInputs || {},
      evidence: evidence as any,
      calculationLines,
    });
  }
  if (input.baseObservation.value <= 0) {
    return createLeaseChargeResult({
      chargeType: input.chargeType,
      leaseId: input.leaseId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: "blocked",
      reasonCodes: ["REFERENCE_BASE_VALUE_INVALID"],
      inputs: input.existingInputs || {},
      evidence: evidence as any,
      calculationLines,
    });
  }

  const rawChangePercent = ((input.currentObservation.value / input.baseObservation.value) - 1) * 100;
  const floor = numberOrNull(input.floorPercent);
  const cap = numberOrNull(input.capPercent);
  let appliedChangePercent = rawChangePercent;
  if (floor != null) appliedChangePercent = Math.max(appliedChangePercent, floor);
  if (cap != null) appliedChangePercent = Math.min(appliedChangePercent, cap);

  const adjustedAmount = roundCurrency(baseAmount * (1 + (appliedChangePercent / 100)));
  const baseEvidence = referenceEvidence("base_index_observation", input.baseObservation);
  const currentEvidence = referenceEvidence("current_index_observation", input.currentObservation);

  return createLeaseChargeResult({
    chargeType: input.chargeType,
    leaseId: input.leaseId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    amount: adjustedAmount,
    status: "calculated",
    reasonCodes: [],
    inputs: {
      ...(input.existingInputs || {}),
      indexAdjustment: {
        baseAmount,
        rawChangePercent,
        appliedChangePercent,
        floorPercent: floor,
        capPercent: cap,
        baseObservation: baseEvidence,
        currentObservation: currentEvidence,
      },
    },
    calculationLines: [
      ...calculationLines,
      {
        sequence: calculationLines.length + 1,
        lineType: "INDEX_ADJUSTMENT",
        formulaCode: "BASE_AMOUNT_X_APPROVED_INDEX_RATIO",
        label: "Approved reference index adjustment",
        inputAmount: baseAmount,
        outputAmount: adjustedAmount,
        explanation: "Base amount adjusted using approved reference observation values frozen into calculation evidence.",
        source: "approved_reference_observations",
      },
    ],
    evidence: [...evidence, baseEvidence, currentEvidence] as any,
  });
}
