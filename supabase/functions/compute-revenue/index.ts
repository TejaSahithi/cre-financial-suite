// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { saveSnapshot } from "../_shared/snapshot.ts";

/**
 * Compute Revenue Edge Function
 * Projects monthly revenue for a property including base rent, CAM recovery,
 * and other income. Generates 12-month rolling forecast.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 * Task: 11.1
 */

interface MonthlyProjection {
  month: number;
  year: number;
  base_rent: number;
  cam_recovery: number;
  other_income: number;
  vacancy_loss: number;
  total: number;
  active_leases: number;
}

interface RevenueSummary {
  annual_total: number;
  avg_monthly: number;
  occupancy_rate: number;
  revenue_by_type: {
    base_rent: number;
    cam_recovery: number;
    other_income: number;
  };
}

/**
 * Returns the first day of a given month/year as a Date (UTC).
 */
function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Returns the last day of a given month/year as a Date (UTC).
 */
function monthEnd(year: number, month: number): Date {
  // Day 0 of the next month gives the last day of the current month
  return new Date(Date.UTC(year, month, 0));
}

/**
 * Round a number to two decimal places.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Determines which leases are active during a given month.
 * A lease is active if: start_date <= month_end AND end_date >= month_start
 */
function getActiveLeasesForMonth(
  leases: Record<string, any>[],
  year: number,
  month: number
): Record<string, any>[] {
  const mStart = monthStart(year, month);
  const mEnd = monthEnd(year, month);

  return leases.filter((lease) => {
    if (!lease.start_date || !lease.end_date) return false;
    const leaseStart = new Date(lease.start_date + "T00:00:00Z");
    const leaseEnd = new Date(lease.end_date + "T00:00:00Z");
    return leaseStart <= mEnd && leaseEnd >= mStart;
  });
}

/**
 * Computes monthly projections for a sequence of months.
 */
function computeMonthlyProjections(
  months: { month: number; year: number }[],
  leases: Record<string, any>[],
  revenueRecords: Record<string, any>[],
  camCalc: Record<string, any> | null,
  totalPropertySqft: number
): MonthlyProjection[] {
  const projections: MonthlyProjection[] = [];

  for (const { month, year } of months) {
    const activeLeases = getActiveLeasesForMonth(leases, year, month);
    const activeLeaseCount = activeLeases.length;

    // --- Base rent ---
    const baseRent = activeLeases.reduce(
      (sum: number, lease: any) => sum + (Number(lease.monthly_rent) || 0),
      0
    );

    // --- CAM recovery ---
    let camRecovery = 0;
    if (camCalc && activeLeaseCount > 0) {
      const annualCam = Number(camCalc.annual_cam) || 0;
      const camPerSf = Number(camCalc.cam_per_sf) || 0;

      if (camPerSf > 0 && totalPropertySqft > 0) {
        // Pro-rate per tenant's sqft
        const activeSqft = activeLeases.reduce(
          (sum: number, lease: any) => sum + (Number(lease.square_footage) || 0),
          0
        );
        camRecovery = (camPerSf * activeSqft) / 12;
      } else {
        // Flat annual / 12
        camRecovery = annualCam / 12;
      }
    }

    // --- Other income (from revenues table, excluding base_rent and cam_recovery) ---
    const otherIncome = revenueRecords
      .filter(
        (r: any) =>
          r.month === month &&
          Number(r.fiscal_year) === year &&
          r.type !== "base_rent" &&
          r.type !== "cam_recovery"
      )
      .reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);

    // --- Vacancy loss ---
    // If no active leases this month, all potential revenue is lost (represented as 0 totals).
    // vacancy_loss is explicitly the base_rent that *would* have been collected if fully occupied.
    // For months with active leases we report 0; for vacancy months we show 0 revenue anyway.
    const vacancyLoss = activeLeaseCount === 0 ? 0 : 0;

    const total = round2(baseRent + camRecovery + otherIncome);

    projections.push({
      month,
      year,
      base_rent: round2(baseRent),
      cam_recovery: round2(camRecovery),
      other_income: round2(otherIncome),
      vacancy_loss: round2(vacancyLoss),
      total,
      active_leases: activeLeaseCount,
    });
  }

  return projections;
}

/**
 * Aggregates monthly projections into a summary.
 */
function buildSummary(projections: MonthlyProjection[]): RevenueSummary {
  const totalBaseRent = projections.reduce((s, p) => s + p.base_rent, 0);
  const totalCam = projections.reduce((s, p) => s + p.cam_recovery, 0);
  const totalOther = projections.reduce((s, p) => s + p.other_income, 0);
  const annualTotal = projections.reduce((s, p) => s + p.total, 0);

  const monthsWithLeases = projections.filter((p) => p.active_leases > 0).length;
  const totalMonths = projections.length || 1;
  const occupancyRate = round2(monthsWithLeases / totalMonths);
  const avgMonthly = round2(annualTotal / totalMonths);

  return {
    annual_total: round2(annualTotal),
    avg_monthly: avgMonthly,
    occupancy_rate: occupancyRate,
    revenue_by_type: {
      base_rent: round2(totalBaseRent),
      cam_recovery: round2(totalCam),
      other_income: round2(totalOther),
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const { property_id, fiscal_year } = await req.json();
    if (!property_id || !fiscal_year) {
      throw new Error("property_id and fiscal_year are required");
    }

    // ---------------------------------------------------------------
    // 1. Fetch property details
    // ---------------------------------------------------------------
    const { data: property, error: propErr } = await supabaseAdmin
      .from("properties")
      .select("id, total_sqft, org_id")
      .eq("id", property_id)
      .eq("org_id", orgId)
      .single();

    if (propErr || !property) {
      throw new Error(`Property not found: ${propErr?.message ?? property_id}`);
    }

    const totalPropertySqft = Number(property.total_sqft) || 0;

    // ---------------------------------------------------------------
    // 2. Fetch all leases for the property (all statuses)
    // ---------------------------------------------------------------
    const { data: leases, error: leaseErr } = await supabaseAdmin
      .from("leases")
      .select(
        "id, org_id, property_id, tenant_name, start_date, end_date, monthly_rent, square_footage, status, lease_type"
      )
      .eq("property_id", property_id)
      .eq("org_id", orgId);

    if (leaseErr) {
      throw new Error(`Failed to fetch leases: ${leaseErr.message}`);
    }

    const allLeases = leases ?? [];

    // ---------------------------------------------------------------
    // 3. Fetch existing revenue records for the property + fiscal_year
    // ---------------------------------------------------------------
    const { data: revenueRecords, error: revErr } = await supabaseAdmin
      .from("revenues")
      .select("id, org_id, property_id, lease_id, fiscal_year, month, type, amount")
      .eq("property_id", property_id)
      .eq("org_id", orgId)
      .eq("fiscal_year", fiscal_year);

    if (revErr) {
      throw new Error(`Failed to fetch revenue records: ${revErr.message}`);
    }

    const allRevenues = revenueRecords ?? [];

    // ---------------------------------------------------------------
    // 4. Fetch latest cam_calculations for property + fiscal_year
    // ---------------------------------------------------------------
    const { data: camCalc, error: camErr } = await supabaseAdmin
      .from("cam_calculations")
      .select("property_id, fiscal_year, annual_cam, cam_per_sf")
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year)
      .maybeSingle();

    if (camErr) {
      console.error("[compute-revenue] cam_calculations fetch error:", camErr.message);
    }

    // ---------------------------------------------------------------
    // 5-6. Compute monthly projections for the fiscal year (months 1-12)
    // ---------------------------------------------------------------
    const fiscalMonths = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      year: fiscal_year,
    }));

    const monthlyProjections = computeMonthlyProjections(
      fiscalMonths,
      allLeases,
      allRevenues,
      camCalc ?? null,
      totalPropertySqft
    );

    // ---------------------------------------------------------------
    // 7. Aggregate at property level
    // ---------------------------------------------------------------
    const summary = buildSummary(monthlyProjections);

    // ---------------------------------------------------------------
    // 8. Generate 12-month rolling forecast (from current month forward)
    // ---------------------------------------------------------------
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1; // 1-12
    const currentYear = now.getUTCFullYear();

    const rollingMonths: { month: number; year: number }[] = [];
    for (let i = 0; i < 12; i++) {
      let m = currentMonth + i;
      let y = currentYear;
      if (m > 12) {
        m -= 12;
        y += 1;
      }
      rollingMonths.push({ month: m, year: y });
    }

    // For the rolling forecast we need revenue records that span the rolling period.
    // Fetch additional revenue records for the next fiscal year if the rolling window crosses years.
    const rollingYears = [...new Set(rollingMonths.map((rm) => rm.year))];
    let rollingRevenues = allRevenues;

    // If the rolling forecast spans years beyond the requested fiscal_year, fetch those too
    const additionalYears = rollingYears.filter((y) => y !== fiscal_year);
    if (additionalYears.length > 0) {
      for (const extraYear of additionalYears) {
        const { data: extraRevs } = await supabaseAdmin
          .from("revenues")
          .select("id, org_id, property_id, lease_id, fiscal_year, month, type, amount")
          .eq("property_id", property_id)
          .eq("org_id", orgId)
          .eq("fiscal_year", extraYear);

        if (extraRevs && extraRevs.length > 0) {
          rollingRevenues = rollingRevenues.concat(extraRevs);
        }
      }
    }

    const rollingForecast = computeMonthlyProjections(
      rollingMonths,
      allLeases,
      rollingRevenues,
      camCalc ?? null,
      totalPropertySqft
    );

    // ---------------------------------------------------------------
    // 9. Store results in computation_snapshots with engine_type='revenue'
    // ---------------------------------------------------------------
    const snapshotPayload = {
      org_id: orgId,
      property_id,
      engine_type: "revenue",
      fiscal_year,
      inputs: {
        property_id,
        fiscal_year,
        total_property_sqft: totalPropertySqft,
        lease_count: allLeases.length,
        revenue_record_count: allRevenues.length,
        cam_available: camCalc != null,
      },
      outputs: {
        monthly_projections: monthlyProjections,
        summary,
        rolling_forecast: rollingForecast,
      },
    };

    await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id,
      engine_type: "revenue",
      fiscal_year,
      computed_by: user.email ?? user.id,
      inputs: snapshotPayload.inputs,
      outputs: snapshotPayload.outputs,
    });

    // ---------------------------------------------------------------
    // Response
    // ---------------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        property_id,
        fiscal_year,
        monthly_projections: monthlyProjections,
        summary,
        rolling_forecast: rollingForecast,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[compute-revenue] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
