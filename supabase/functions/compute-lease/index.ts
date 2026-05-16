// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";
import {
  asInteger,
  asText,
  buildAssumedRenewalRows,
  filterRowsForProjectionMode,
  formatDateUtc,
  generateApprovedRentScheduleRows,
  isApprovedLease,
  leaseRsf,
  monthEndUtc,
  monthKey,
  monthLabel,
  monthStartUtc,
  nextFiscalYearExplanation,
  normalizedLeaseDates,
  normalizeProjectionMode,
  normalizeScopeSelection,
  parseDateUtc,
  projectedAmountForMonth,
  round2,
} from "../_shared/rent-schedule.ts";

interface RentScheduleEntry {
  month: string;
  month_index: number;
  scheduled_rent: number;
}

interface LeaseSummary {
  fy_scheduled_rent: number;
  next_fy_scheduled_rent: number;
  annualized_rent: number;
  rent_psf: number | null;
  next_fy_zero_explanation: string | null;
}

interface LeaseResult {
  error: boolean;
  lease_id: string;
  tenant_name?: string;
  lease_type?: string | null;
  current_fy_months?: RentScheduleEntry[];
  next_fy_months?: RentScheduleEntry[];
  approved_rent_schedule_rows?: Record<string, any>[];
  summary?: LeaseSummary;
  message?: string;
}

function approvedLeaseDatesSummary(lease: Record<string, any>) {
  const dates = normalizedLeaseDates(lease);
  return {
    lease_start: formatDateUtc(dates.leaseStart),
    rent_commencement_date: formatDateUtc(dates.rentStart),
    lease_end: formatDateUtc(dates.leaseEnd),
  };
}

function monthsForFiscalYear(fiscalYear: number) {
  return Array.from({ length: 12 }, (_, monthIndex) => {
    const start = monthStartUtc(fiscalYear, monthIndex);
    const end = monthEndUtc(fiscalYear, monthIndex);
    return {
      monthIndex,
      label: monthLabel(monthIndex),
      key: monthKey(start),
      start,
      end,
    };
  });
}

function leaseAnnualizedRent(months: RentScheduleEntry[], nextMonths: RentScheduleEntry[]): number {
  const reversed = [...months].reverse();
  const latest = reversed.find((row) => row.scheduled_rent > 0) ?? nextMonths.find((row) => row.scheduled_rent > 0) ?? null;
  return latest ? round2(latest.scheduled_rent * 12) : 0;
}

function computeLeaseProjection(
  lease: Record<string, any>,
  approvedRows: Record<string, any>[],
  fiscalYear: number,
  projectionMode: string,
): LeaseResult {
  const nextFiscalYear = fiscalYear + 1;
  const projectionEnd = monthEndUtc(nextFiscalYear, 11);
  const assumedRows = projectionMode === "include_assumed_renewals"
    ? buildAssumedRenewalRows(lease, approvedRows, projectionEnd)
    : [];
  const visibleRows = filterRowsForProjectionMode([...approvedRows, ...assumedRows], projectionMode);

  const currentMonths = monthsForFiscalYear(fiscalYear).map((month) => ({
    month: month.label,
    month_index: month.monthIndex + 1,
    scheduled_rent: round2(
      visibleRows.reduce((sum, row) => sum + projectedAmountForMonth(row, month.start, month.end), 0),
    ),
  }));
  const nextMonths = monthsForFiscalYear(nextFiscalYear).map((month) => ({
    month: month.label,
    month_index: month.monthIndex + 1,
    scheduled_rent: round2(
      visibleRows.reduce((sum, row) => sum + projectedAmountForMonth(row, month.start, month.end), 0),
    ),
  }));

  const fyScheduledRent = round2(currentMonths.reduce((sum, row) => sum + row.scheduled_rent, 0));
  const nextFyScheduledRent = round2(nextMonths.reduce((sum, row) => sum + row.scheduled_rent, 0));
  const annualizedRent = leaseAnnualizedRent(currentMonths, nextMonths);
  const rsf = leaseRsf(lease);
  const rentPsf = rsf > 0 && annualizedRent > 0 ? round2(annualizedRent / rsf) : null;

  return {
    error: false,
    lease_id: lease.id,
    tenant_name: lease.tenant_name ?? "Unknown",
    lease_type: lease.lease_type ?? null,
    current_fy_months: currentMonths,
    next_fy_months: nextMonths,
    approved_rent_schedule_rows: approvedRows,
    summary: {
      fy_scheduled_rent: fyScheduledRent,
      next_fy_scheduled_rent: nextFyScheduledRent,
      annualized_rent: annualizedRent,
      rent_psf: rentPsf,
      next_fy_zero_explanation: nextFiscalYearExplanation(lease, nextFyScheduledRent, projectionMode as any),
    },
  };
}

async function ensureApprovedRentSchedules(
  supabaseAdmin: any,
  leases: Record<string, any>[],
  orgId: string,
) {
  const leaseIds = leases.map((lease) => lease.id).filter(Boolean);
  if (leaseIds.length === 0) return [];

  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from("rent_schedules")
    .select("*")
    .eq("org_id", orgId)
    .in("lease_id", leaseIds)
    .eq("status", "approved");

  if (existingError) {
    throw new Error(`Failed to fetch approved rent schedules: ${existingError.message}`);
  }

  const byLeaseId = new Map<string, Record<string, any>[]>();
  for (const row of existingRows || []) {
    const bucket = byLeaseId.get(row.lease_id) ?? [];
    bucket.push(row);
    byLeaseId.set(row.lease_id, bucket);
  }

  const leasesNeedingRefresh = leases.filter((lease) => {
    const currentVersion = asInteger(lease.abstract_version) ?? 1;
    const rows = byLeaseId.get(lease.id) ?? [];
    return !rows.some((row) =>
      row.source === "approved_abstract" &&
      row.phase === "contracted" &&
      (asInteger(row.abstract_version) ?? 1) === currentVersion,
    );
  });

  if (leasesNeedingRefresh.length > 0) {
    const deleteLeaseIds = leasesNeedingRefresh.map((lease) => lease.id);
    const { error: deleteError } = await supabaseAdmin
      .from("rent_schedules")
      .delete()
      .eq("org_id", orgId)
      .eq("source", "approved_abstract")
      .in("lease_id", deleteLeaseIds);

    if (deleteError) {
      throw new Error(`Failed to refresh approved rent schedules: ${deleteError.message}`);
    }

    const rowsToInsert = leasesNeedingRefresh.flatMap((lease) => generateApprovedRentScheduleRows(lease));
    if (rowsToInsert.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("rent_schedules")
        .insert(rowsToInsert);
      if (insertError) {
        throw new Error(`Failed to store approved rent schedules: ${insertError.message}`);
      }
    }
  }

  const { data: finalRows, error: finalError } = await supabaseAdmin
    .from("rent_schedules")
    .select("*")
    .eq("org_id", orgId)
    .in("lease_id", leaseIds)
    .eq("status", "approved");

  if (finalError) {
    throw new Error(`Failed to reload approved rent schedules: ${finalError.message}`);
  }

  return finalRows || [];
}

function aggregateOutputs(
  leases: Record<string, any>[],
  results: LeaseResult[],
  fiscalYear: number,
  projectionMode: string,
  scopeLevel: string,
  scopeId: string | null,
) {
  const currentYearMonths = monthsForFiscalYear(fiscalYear);
  const nextYearMonths = monthsForFiscalYear(fiscalYear + 1);

  const monthlyProjections = currentYearMonths.map((month, index) => ({
    month: index + 1,
    label: month.label,
    base_rent: round2(
      results.reduce((sum, result) => sum + Number(result.current_fy_months?.[index]?.scheduled_rent || 0), 0),
    ),
    projected_rent: round2(
      results.reduce((sum, result) => sum + Number(result.next_fy_months?.[index]?.scheduled_rent || 0), 0),
    ),
  }));

  const leaseSummaries = results.map((result) => {
    const lease = leases.find((row) => row.id === result.lease_id) ?? {};
    const dates = approvedLeaseDatesSummary(lease);
    return {
      lease_id: result.lease_id,
      tenant_name: result.tenant_name ?? lease.tenant_name ?? "Unknown",
      property_id: lease.property_id ?? null,
      building_id: lease.building_id ?? null,
      unit_id: lease.unit_id ?? null,
      lease_type: result.lease_type ?? lease.lease_type ?? null,
      rsf: leaseRsf(lease),
      fy_scheduled_rent: result.summary?.fy_scheduled_rent ?? 0,
      next_fy_scheduled_rent: result.summary?.next_fy_scheduled_rent ?? 0,
      annualized_rent: result.summary?.annualized_rent ?? 0,
      rent_psf: result.summary?.rent_psf ?? null,
      next_fy_zero_explanation: result.summary?.next_fy_zero_explanation ?? null,
      projection_mode: projectionMode,
      ...dates,
    };
  });

  const totalScheduledRent = round2(monthlyProjections.reduce((sum, row) => sum + Number(row.base_rent || 0), 0));
  const totalProjectedRent = round2(monthlyProjections.reduce((sum, row) => sum + Number(row.projected_rent || 0), 0));
  const totalAnnualizedRent = round2(leaseSummaries.reduce((sum, row) => sum + Number(row.annualized_rent || 0), 0));
  const totalRsf = leaseSummaries.reduce((sum, row) => sum + Number(row.rsf || 0), 0);

  return {
    scope_level: scopeLevel,
    scope_id: scopeId,
    projection_mode: projectionMode,
    fiscal_year: fiscalYear,
    next_fiscal_year: fiscalYear + 1,
    tenant_schedules: leaseSummaries,
    lease_summaries: leaseSummaries,
    monthly_projections: monthlyProjections,
    summary: {
      total_rent: totalScheduledRent,
      total_projected_rent: totalProjectedRent,
      avg_monthly_rent: round2(totalScheduledRent / 12),
      avg_projected_monthly: round2(totalProjectedRent / 12),
      total_annualized_rent: totalAnnualizedRent,
      avg_rent_psf: totalRsf > 0 ? round2(totalAnnualizedRent / totalRsf) : null,
      lease_count: leaseSummaries.length,
      projection_mode: projectionMode,
      scope_level: scopeLevel,
      scope_id: scopeId,
    },
    current_fy_months: currentYearMonths.map((month) => month.label),
    next_fy_months: nextYearMonths.map((month) => month.label),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json().catch(() => ({}));
    const leaseId = asText(body?.lease_id);
    const propertyId = asText(body?.property_id);
    const buildingId = asText(body?.building_id);
    const unitId = asText(body?.unit_id);
    const fiscalYear = asInteger(body?.fiscal_year) ?? new Date().getUTCFullYear();
    const projectionMode = normalizeProjectionMode(body?.projection_mode);
    const scope = normalizeScopeSelection(body);

    if (!leaseId && !propertyId) {
      throw new Error("Request must include lease_id or property_id");
    }

    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview", "RentProjection"], "write");
    if (propertyId) {
      await assertPropertyAccess(req, propertyId);
    }

    let leaseQuery = supabaseAdmin
      .from("leases")
      .select("*")
      .eq("org_id", orgId);

    if (leaseId) leaseQuery = leaseQuery.eq("id", leaseId);
    if (propertyId) leaseQuery = leaseQuery.eq("property_id", propertyId);
    if (buildingId) leaseQuery = leaseQuery.eq("building_id", buildingId);
    if (unitId) leaseQuery = leaseQuery.eq("unit_id", unitId);

    const { data: fetchedLeases, error: leaseError } = await leaseQuery;
    if (leaseError) {
      throw new Error(`Failed to fetch leases: ${leaseError.message}`);
    }

    const sourceLeases = fetchedLeases || [];
    if (!propertyId && sourceLeases.length === 1 && sourceLeases[0]?.property_id) {
      await assertPropertyAccess(req, sourceLeases[0].property_id);
    }
    const approvedLeases = sourceLeases.filter((lease) => isApprovedLease(lease));

    const approvedRows = await ensureApprovedRentSchedules(supabaseAdmin, approvedLeases, orgId);
    const rowsByLeaseId = new Map<string, Record<string, any>[]>();
    for (const row of approvedRows) {
      const bucket = rowsByLeaseId.get(row.lease_id) ?? [];
      bucket.push(row);
      rowsByLeaseId.set(row.lease_id, bucket);
    }

    const results = approvedLeases.map((lease) =>
      computeLeaseProjection(lease, rowsByLeaseId.get(lease.id) ?? [], fiscalYear, projectionMode)
    );

    if (leaseId) {
      if (results.length === 0) {
        return new Response(
          JSON.stringify({
            error: false,
            lease_id: leaseId,
            message: "Lease is not approved yet, so no authoritative rent projection is available.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(results[0]), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const outputs = aggregateOutputs(
      approvedLeases,
      results,
      fiscalYear,
      projectionMode,
      scope.scopeLevel,
      scope.scopeId,
    );

    const snapshotInputs = {
      property_id: propertyId,
      building_id: buildingId,
      unit_id: unitId,
      fiscal_year: fiscalYear,
      projection_mode: projectionMode,
      scope_level: scope.scopeLevel,
      scope_id: scope.scopeId,
      approved_lease_count: approvedLeases.length,
      _compute: {
        page_scope: ["Leases", "LeaseUpload", "LeaseReview", "RentProjection"],
        source_tables: ["leases", "rent_schedules"],
        source_row_ids: {
          leases: approvedLeases.map((lease) => lease.id).sort(),
          rent_schedules: approvedRows.map((row) => row.id).sort(),
        },
        source_counts: {
          leases: approvedLeases.length,
          rent_schedules: approvedRows.length,
        },
        trigger_type: req.headers.get("x-compute-trigger") ?? "manual",
        source_file_id: req.headers.get("x-source-file-id") ?? null,
      },
    };

    const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId ?? null,
      engine_type: "lease",
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      inputs: snapshotInputs,
      outputs,
    });

    if (existingSnapshot?.outputs) {
      return new Response(
        JSON.stringify({
          error: false,
          property_id: propertyId,
          fiscal_year: fiscalYear,
          projection_mode: projectionMode,
          results,
          outputs: existingSnapshot.outputs,
          snapshot_id: existingSnapshot.id,
          reused_snapshot: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const snapshotId = await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId ?? null,
      engine_type: "lease",
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      inputs: snapshotInputs,
      outputs,
    });

    return new Response(
      JSON.stringify({
        error: false,
        property_id: propertyId,
        fiscal_year: fiscalYear,
        projection_mode: projectionMode,
        results,
        outputs,
        snapshot_id: snapshotId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[compute-lease] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
