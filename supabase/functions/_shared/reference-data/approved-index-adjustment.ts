// @ts-nocheck
import {
  evaluateIndexAdjustedLeaseCharge,
  selectApprovedReferenceObservation,
} from "./reference-observation-consumption.ts";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean) as T[])];
}

export function isApprovedIndexAdjustmentRule(rule: Record<string, unknown> | null | undefined): boolean {
  const type = lower(rule?.index_adjustment_type);
  const name = lower(rule?.index_name);
  const source = lower(rule?.index_source ?? rule?.index_provider ?? rule?.provider);
  return Boolean(rule?.index_adjustment_applicable || /\b(cpi|index)\b/.test(`${type} ${name} ${source}`));
}

export function normalizeApprovedIndexRule(row: Record<string, unknown> | null | undefined) {
  return {
    index_adjustment_applicable: Boolean(row?.index_adjustment_applicable),
    index_adjustment_type: row?.index_adjustment_type ?? null,
    index_name: row?.index_name ?? null,
    index_provider: row?.index_provider ?? row?.reference_provider ?? row?.provider ?? row?.index_source ?? null,
    index_series_id: row?.index_series_id ?? row?.reference_series_id ?? row?.provider_series_id ?? row?.series_id ?? null,
    index_base_period: row?.index_base_period ?? row?.base_period ?? null,
    index_current_period: row?.index_current_period ?? row?.current_period ?? null,
    index_floor_percent: asNumber(row?.index_floor_percent ?? row?.floor_percent),
    index_cap_percent: asNumber(row?.index_cap_percent ?? row?.cap_percent),
    source: row ?? {},
  };
}

async function loadApprovedSeriesSelections(supabaseAdmin: any, input: {
  orgId: string;
  leaseId?: string | null;
  provider?: string | null;
  seriesId?: string | null;
  fieldKeys: string[];
}) {
  let query = supabaseAdmin
    .from("reference_series_selections")
    .select("id,org_id,lease_id,field_key,provider,series_id,display_name,geography,frequency,units,status,approved_at,approved_by,evidence")
    .eq("org_id", input.orgId)
    .eq("status", "approved")
    .in("field_key", input.fieldKeys)
    .order("approved_at", { ascending: false, nullsFirst: false })
    .limit(3);
  if (input.leaseId) query = query.eq("lease_id", input.leaseId);
  if (input.provider) query = query.eq("provider", input.provider);
  if (input.seriesId) query = query.eq("series_id", input.seriesId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load approved reference series selection: ${error.message}`);
  return data || [];
}

async function loadReferenceRows(supabaseAdmin: any, input: {
  orgId: string;
  provider: string;
  seriesId: string;
  periods: string[];
}) {
  const periods = unique(input.periods);
  if (!periods.length) return [];
  const { data, error } = await supabaseAdmin
    .from("reference_observations")
    .select("id,org_id,provider,series_id,period,value,retrieved_at,source_url,payload_fingerprint,status,approved_at,approved_by")
    .eq("org_id", input.orgId)
    .eq("provider", input.provider)
    .eq("series_id", input.seriesId)
    .in("period", periods);
  if (error) throw new Error(`Failed to load approved reference observations: ${error.message}`);
  return data || [];
}

function blockedIndexResult(input: {
  chargeType: string;
  leaseId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  reasonCodes: string[];
  indexInputs: Record<string, unknown>;
  existingInputs?: Record<string, unknown>;
  existingEvidence?: unknown[];
  existingCalculationLines?: unknown[];
}) {
  return {
    chargeType: input.chargeType,
    leaseId: input.leaseId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    amount: null,
    status: "blocked",
    reasonCodes: unique(input.reasonCodes),
    inputs: { ...(input.existingInputs || {}), indexAdjustment: { ...input.indexInputs, status: "blocked" } },
    evidence: input.existingEvidence || [],
    calculationLines: input.existingCalculationLines || [],
  };
}

export async function resolveApprovedIndexAdjustment(supabaseAdmin: any, input: {
  orgId: string;
  leaseId?: string | null;
  rule: Record<string, unknown> | null | undefined;
  fieldKeys: string[];
  chargeType: string;
  baseAmount: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  existingInputs?: Record<string, unknown>;
  existingEvidence?: unknown[];
  existingCalculationLines?: unknown[];
}) {
  const rule = normalizeApprovedIndexRule(input.rule);
  if (!isApprovedIndexAdjustmentRule(rule)) {
    return { skipped: true, result: null };
  }

  const basePeriod = clean(rule.index_base_period);
  const currentPeriod = clean(rule.index_current_period);
  let provider = lower(rule.index_provider);
  let seriesId = clean(rule.index_series_id);

  const matchingSelections = await loadApprovedSeriesSelections(supabaseAdmin, {
    orgId: input.orgId,
    leaseId: input.leaseId,
    provider: provider || null,
    seriesId: seriesId || null,
    fieldKeys: input.fieldKeys,
  });

  if (matchingSelections.length > 1) {
    return {
      skipped: false,
      result: blockedIndexResult({
        ...input,
        reasonCodes: ["REFERENCE_SERIES_AMBIGUOUS"],
        indexInputs: { provider: provider || null, seriesId: seriesId || null, basePeriod, currentPeriod, selectedSeries: null },
      }),
    };
  }

  const selectedSeries = matchingSelections[0] || null;
  provider = provider || lower(selectedSeries?.provider);
  seriesId = seriesId || clean(selectedSeries?.series_id);

  const indexInputs = {
    provider: provider || null,
    seriesId: seriesId || null,
    basePeriod: basePeriod || null,
    currentPeriod: currentPeriod || null,
    floorPercent: rule.index_floor_percent,
    capPercent: rule.index_cap_percent,
    selectedSeries: selectedSeries ? {
      id: selectedSeries.id,
      fieldKey: selectedSeries.field_key,
      provider: selectedSeries.provider,
      seriesId: selectedSeries.series_id,
      displayName: selectedSeries.display_name,
      approvedAt: selectedSeries.approved_at,
      approvedBy: selectedSeries.approved_by,
    } : null,
  };

  const missing = [];
  if (!selectedSeries) missing.push("REFERENCE_SERIES_APPROVAL_REQUIRED");
  if (!provider) missing.push("REFERENCE_PROVIDER_REQUIRED");
  if (!seriesId) missing.push("REFERENCE_SERIES_APPROVAL_REQUIRED");
  if (!basePeriod) missing.push("REFERENCE_BASE_PERIOD_REQUIRED");
  if (!currentPeriod) missing.push("REFERENCE_CURRENT_PERIOD_REQUIRED");
  if (input.baseAmount == null) missing.push("INDEX_ADJUSTMENT_BASE_AMOUNT_REQUIRED");

  if (missing.length) {
    return {
      skipped: false,
      result: blockedIndexResult({ ...input, reasonCodes: missing, indexInputs }),
    };
  }

  const rows = await loadReferenceRows(supabaseAdmin, {
    orgId: input.orgId,
    provider,
    seriesId,
    periods: [basePeriod, currentPeriod],
  });
  const baseSelection = selectApprovedReferenceObservation(rows, { orgId: input.orgId, provider, seriesId, period: basePeriod });
  const currentSelection = selectApprovedReferenceObservation(rows, { orgId: input.orgId, provider, seriesId, period: currentPeriod });
  const blockers = [
    ...(baseSelection.ok ? [] : baseSelection.reasonCodes.map((code) => `BASE_${code}`)),
    ...(currentSelection.ok ? [] : currentSelection.reasonCodes.map((code) => `CURRENT_${code}`)),
  ];

  if (blockers.length) {
    return {
      skipped: false,
      result: blockedIndexResult({ ...input, reasonCodes: blockers, indexInputs }),
    };
  }

  const result = evaluateIndexAdjustedLeaseCharge({
    chargeType: input.chargeType,
    leaseId: input.leaseId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseAmount: input.baseAmount,
    baseObservation: baseSelection.observation,
    currentObservation: currentSelection.observation,
    floorPercent: rule.index_floor_percent,
    capPercent: rule.index_cap_percent,
    existingInputs: { ...(input.existingInputs || {}), indexAdjustment: indexInputs },
    existingEvidence: input.existingEvidence || [],
    existingCalculationLines: input.existingCalculationLines || [],
  });

  return { skipped: false, result };
}

