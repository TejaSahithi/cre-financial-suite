// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";
import { evaluateManagementFee } from "../_shared/lease-charges/management-fee-evaluator.ts";
import { operationalStatus, writeOperationalAudit } from "../_shared/operational-audit.ts";
import {
  evaluateIndexAdjustedLeaseCharge,
  selectApprovedReferenceObservation,
} from "../_shared/reference-data/reference-observation-consumption.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|invalid/i.test(message)) return 400;
  return 500;
}

function asNumber(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRule(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    fee_percent: asNumber(row.admin_fee_percent ?? row.management_fee_percent ?? row.admin_fee_pct),
    fixed_amount: asNumber(row.management_fee_amount ?? row.fixed_amount),
    basis: row.management_fee_basis ?? row.allocation_basis ?? null,
    index_adjustment_applicable: Boolean(row.index_adjustment_applicable),
    index_adjustment_type: row.index_adjustment_type ?? null,
    index_provider: row.index_provider ?? row.reference_provider ?? row.provider ?? null,
    index_series_id: row.index_series_id ?? row.reference_series_id ?? row.provider_series_id ?? row.series_id ?? null,
    index_base_period: row.index_base_period ?? null,
    index_current_period: row.index_current_period ?? null,
    index_floor_percent: asNumber(row.index_floor_percent),
    index_cap_percent: asNumber(row.index_cap_percent),
    sourceEvidence: row.source_evidence || row.evidence || [],
    source: row,
  };
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isIndexAdjustmentRule(rule: Record<string, unknown> | null | undefined) {
  const type = clean(rule?.index_adjustment_type).toLowerCase();
  return Boolean(rule?.index_adjustment_applicable || /\b(cpi|index)\b/.test(type));
}

async function loadApprovedReferenceSeriesSelections(
  supabaseAdmin: any,
  { orgId, leaseId, provider }: { orgId: string; leaseId: string; provider?: string | null },
) {
  let query = supabaseAdmin
    .from("reference_series_selections")
    .select("id,org_id,lease_id,field_key,provider,series_id,display_name,geography,frequency,units,status,approved_at,approved_by,evidence")
    .eq("org_id", orgId)
    .eq("lease_id", leaseId)
    .eq("status", "approved")
    .in("field_key", ["management_fee_index_adjustment", "management_fee", "index_adjustment", "cpi"])
    .order("approved_at", { ascending: false, nullsFirst: false })
    .limit(2);
  if (provider) query = query.eq("provider", provider);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load approved reference series selection: ${error.message}`);
  return data || [];
}
async function loadApprovedReferenceRows(
  supabaseAdmin: any,
  { orgId, provider, seriesId, periods }: { orgId: string; provider: string; seriesId: string; periods: string[] },
) {
  const uniquePeriods = [...new Set(periods.filter(Boolean))];
  if (!uniquePeriods.length) return [];
  const { data, error } = await supabaseAdmin
    .from("reference_observations")
    .select("id,org_id,provider,series_id,period,value,retrieved_at,source_url,payload_fingerprint,status,approved_at,approved_by")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("series_id", seriesId)
    .in("period", uniquePeriods);
  if (error) throw new Error(`Failed to load approved reference observations: ${error.message}`);
  return data || [];
}

async function applyApprovedIndexAdjustment(
  supabaseAdmin: any,
  result: any,
  rule: Record<string, unknown> | null,
  { orgId, leaseId, periodStart, periodEnd }: { orgId: string; leaseId: string; periodStart: string; periodEnd: string },
) {
  if (!isIndexAdjustmentRule(rule)) return result;

  let provider = clean(rule?.index_provider).toLowerCase();
  let seriesId = clean(rule?.index_series_id);
  const basePeriod = clean(rule?.index_base_period);
  const currentPeriod = clean(rule?.index_current_period);
  let selectedSeries = null;

  if (!seriesId) {
    const selections = await loadApprovedReferenceSeriesSelections(supabaseAdmin, { orgId, leaseId, provider });
    if (selections.length > 1) {
      return {
        ...result,
        amount: null,
        status: "blocked",
        reasonCodes: [...new Set([...(result.reasonCodes || []), "REFERENCE_SERIES_AMBIGUOUS"])],
        inputs: { ...(result.inputs || {}), indexAdjustment: { provider: provider || null, seriesId: null, status: "blocked" } },
      };
    }
    selectedSeries = selections[0] || null;
    provider = provider || clean(selectedSeries?.provider).toLowerCase();
    seriesId = clean(selectedSeries?.series_id);
  }

  const indexInputs = {
    provider: provider || null,
    seriesId: seriesId || null,
    basePeriod: basePeriod || null,
    currentPeriod: currentPeriod || null,
    floorPercent: rule?.index_floor_percent ?? null,
    capPercent: rule?.index_cap_percent ?? null,
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
  if (!provider) missing.push("REFERENCE_PROVIDER_REQUIRED");
  if (!seriesId) missing.push("REFERENCE_SERIES_APPROVAL_REQUIRED");
  if (!basePeriod) missing.push("REFERENCE_BASE_PERIOD_REQUIRED");
  if (!currentPeriod) missing.push("REFERENCE_CURRENT_PERIOD_REQUIRED");

  if (result.status !== "calculated") {
    return {
      ...result,
      reasonCodes: [...new Set([...(result.reasonCodes || []), "INDEX_ADJUSTMENT_SKIPPED_UNTIL_BASE_CALCULATION_READY"])],
      inputs: { ...(result.inputs || {}), indexAdjustment: { ...indexInputs, status: "blocked" } },
    };
  }

  if (missing.length > 0) {
    return {
      ...result,
      amount: null,
      status: "blocked",
      reasonCodes: [...new Set([...(result.reasonCodes || []), ...missing])],
      inputs: { ...(result.inputs || {}), indexAdjustment: { ...indexInputs, status: "blocked" } },
    };
  }

  const rows = await loadApprovedReferenceRows(supabaseAdmin, {
    orgId,
    provider,
    seriesId,
    periods: [basePeriod, currentPeriod],
  });
  const baseSelection = selectApprovedReferenceObservation(rows, { orgId, provider, seriesId, period: basePeriod });
  const currentSelection = selectApprovedReferenceObservation(rows, { orgId, provider, seriesId, period: currentPeriod });
  const blockers = [
    ...(baseSelection.ok ? [] : baseSelection.reasonCodes.map((code) => `BASE_${code}`)),
    ...(currentSelection.ok ? [] : currentSelection.reasonCodes.map((code) => `CURRENT_${code}`)),
  ];

  if (blockers.length > 0) {
    return {
      ...result,
      amount: null,
      status: "blocked",
      reasonCodes: [...new Set([...(result.reasonCodes || []), ...blockers])],
      inputs: { ...(result.inputs || {}), indexAdjustment: { ...indexInputs, status: "blocked" } },
    };
  }

  return evaluateIndexAdjustedLeaseCharge({
    chargeType: result.chargeType,
    leaseId: result.leaseId,
    periodStart: result.periodStart ?? periodStart,
    periodEnd: result.periodEnd ?? periodEnd,
    baseAmount: result.amount,
    baseObservation: baseSelection.observation,
    currentObservation: currentSelection.observation,
    floorPercent: rule?.index_floor_percent,
    capPercent: rule?.index_cap_percent,
    existingInputs: result.inputs || {},
    existingEvidence: result.evidence || [],
    existingCalculationLines: result.calculationLines || [],
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["RentProjection", "LeaseExpenseRules", "LeaseReview"], "read");

    const body = await req.json().catch(() => ({}));
    const leaseId = String(body.lease_id ?? body.leaseId ?? "").trim();
    const periodStart = String(body.period_start ?? body.periodStart ?? "").trim();
    const periodEnd = String(body.period_end ?? body.periodEnd ?? "").trim();
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? periodEnd ?? "").trim();

    if (!UUID_RE.test(leaseId)) throw new Error("lease_id is required");
    if (!DATE_RE.test(periodStart)) throw new Error("period_start is required in YYYY-MM-DD format");
    if (!DATE_RE.test(periodEnd)) throw new Error("period_end is required in YYYY-MM-DD format");
    if (!DATE_RE.test(asOfDate)) throw new Error("as_of_date is required in YYYY-MM-DD format");

    const snapshot = await loadLeaseTermsSnapshot(supabaseAdmin, { orgId, leaseId });
    if (!snapshot) throw new Error("Lease not found");
    if (snapshot.propertyId) await assertPropertyAccess(req, snapshot.propertyId);

    const resolvedTerms = resolveLeaseTerms(snapshot, asOfDate);
    const { data: rules, error: ruleError } = await supabaseAdmin
      .from("lease_expense_rules")
      .select("*")
      .eq("org_id", orgId)
      .eq("lease_id", leaseId)
      .in("review_status", ["approved", "active"])
      .or("expense_category.ilike.%management%,expense_category.ilike.%admin%,category.ilike.%management%,category.ilike.%admin%")
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(10);
    if (ruleError) throw new Error(`Failed to load management fee rule: ${ruleError.message}`);

    const rule = normalizeRule((rules ?? []).find((row: Record<string, unknown>) =>
      asNumber(row.admin_fee_percent ?? row.management_fee_percent ?? row.admin_fee_pct) != null ||
      asNumber(row.management_fee_amount ?? row.fixed_amount) != null
    ) ?? null);
    const baseResult = evaluateManagementFee({ resolvedTerms, rule, asOfDate, periodStart, periodEnd });
    const result = await applyApprovedIndexAdjustment(supabaseAdmin, baseResult, rule, { orgId, leaseId, periodStart, periodEnd });

    const row = {
      org_id: orgId,
      lease_id: leaseId,
      property_id: snapshot.propertyId ?? null,
      charge_type: "management_fee",
      period_start: periodStart,
      period_end: periodEnd,
      calculated_amount: result.amount,
      currency: result.currency || "USD",
      status: operationalStatus(result.status),
      reason_codes: result.reasonCodes ?? [],
      calculation_lines: result.calculationLines ?? [],
      inputs: {
        ...(result.inputs ?? {}),
        resolved_terms: resolvedTerms,
        rule: rule?.source ?? null,
      },
      evidence: result.evidence ?? [],
      source: "compute-management-fee",

      calculated_by: user.id,
    };

    const { data: savedCalculation, error: saveError } = await supabaseAdmin
      .from("lease_charge_calculations")
      .upsert(row, { onConflict: "org_id,lease_id,charge_type,period_start,period_end" })
      .select("*")
      .single();
    if (saveError) throw new Error(`Failed to persist management fee calculation: ${saveError.message}`);

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "lease_charge_calculation",
      entityId: savedCalculation?.id ?? null,
      action: "MANAGEMENT_FEE_CALCULATED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      propertyId: snapshot.propertyId ?? null,
      newValue: savedCalculation,
      source: "compute-management-fee",
    });

    return jsonResponse({ error: false, data: result, resolved_terms: resolvedTerms, saved_calculation: savedCalculation });
  } catch (error) {
    const message = error?.message || "Could not compute management fee";
    console.error("[compute-management-fee]", message);
    return jsonResponse({ error: true, message, error_code: "COMPUTE_MANAGEMENT_FEE_FAILED" }, errorStatus(message));
  }
});
