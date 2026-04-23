// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";

/**
 * Compute Lease Edge Function
 * Calculates rent schedules, escalations, CAM charges per lease
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 * Task: 8.1
 */

interface RentScheduleEntry {
  month: string;
  base_rent: number;
  escalated_rent: number;
  cam_charge: number;
  total_rent: number;
}

interface LeaseSummary {
  total_rent: number;
  avg_monthly_rent: number;
  term_months: number;
  escalation_count: number;
}

interface LeaseResult {
  error: boolean;
  lease_id: string;
  rent_schedule?: RentScheduleEntry[];
  summary?: LeaseSummary;
  message?: string;
}

/**
 * Generates an array of "YYYY-MM" strings for each month from start to end (inclusive).
 */
function generateMonthRange(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  while (cursor <= endCursor) {
    const yyyy = cursor.getUTCFullYear();
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    months.push(`${yyyy}-${mm}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

/**
 * Determines how many full years have elapsed since the lease start for a given month,
 * used to decide when annual escalations kick in.
 */
function getLeaseYear(startDate: string, currentMonth: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const current = new Date(currentMonth + "-01T00:00:00Z");

  const yearDiff = current.getUTCFullYear() - start.getUTCFullYear();
  const monthDiff = current.getUTCMonth() - start.getUTCMonth();

  // If we haven't yet reached the anniversary month this calendar year, subtract one
  if (monthDiff < 0) {
    return yearDiff - 1;
  }
  return yearDiff;
}

/**
 * Computes the rent schedule for a single lease.
 */
function computeLeaseSchedule(
  lease: Record<string, any>,
  leaseConfig: Record<string, any> | null,
  propertyConfig: Record<string, any> | null
): LeaseResult {
  if (!lease.start_date || !lease.end_date) {
    return {
      error: true,
      lease_id: lease.id,
      message: `Lease ${lease.id} is missing start_date or end_date`,
    };
  }

  const months = generateMonthRange(lease.start_date, lease.end_date);
  if (months.length === 0) {
    return {
      error: true,
      lease_id: lease.id,
      message: `Lease ${lease.id} has an invalid date range (start_date: ${lease.start_date}, end_date: ${lease.end_date})`,
    };
  }

  const baseRent = Number(lease.monthly_rent) || 0;
  const squareFootage = Number(lease.square_footage) || 0;

  // Extract escalation config from lease_config.config_values
  const configValues = leaseConfig?.config_values ?? {};
  const escalationType: string = configValues.escalation_type ?? "none";
  let escalationRate: number;

  if (escalationType === "cpi") {
    escalationRate = Number(configValues.cpi_rate ?? 3) / 100;
  } else if (escalationType === "fixed") {
    escalationRate = Number(configValues.escalation_rate ?? 0) / 100;
  } else {
    escalationRate = 0;
  }

  // CAM configuration
  const camCap = leaseConfig?.cam_cap != null ? Number(leaseConfig.cam_cap) : null;
  const propConfigValues = propertyConfig?.config_values ?? {};
  const camPerSf = Number(propConfigValues.cam_per_sf ?? 0);
  const rawMonthlyCam = squareFootage * camPerSf;

  // Base year expense recovery
  const baseYear = leaseConfig?.base_year ?? null;
  const expenseRecoveryMethod = propertyConfig?.expense_recovery_method ?? "none";
  const baseYearAmount = Number(configValues.base_year_amount ?? 0);

  const rentSchedule: RentScheduleEntry[] = [];
  let escalationCount = 0;
  let totalRent = 0;

  // Track escalated rent by lease year so we compound annually
  const escalatedRentByYear: Map<number, number> = new Map();

  for (const month of months) {
    const leaseYear = getLeaseYear(lease.start_date, month);

    // Determine the escalated base rent for this lease year
    let escalatedRent: number;
    if (escalationRate === 0 || leaseYear <= 0) {
      escalatedRent = baseRent;
    } else {
      if (escalatedRentByYear.has(leaseYear)) {
        escalatedRent = escalatedRentByYear.get(leaseYear)!;
      } else {
        // Compound from the previous year's rent
        const previousYearRent = escalatedRentByYear.get(leaseYear - 1) ?? baseRent;
        escalatedRent = Math.round(previousYearRent * (1 + escalationRate) * 100) / 100;
        escalatedRentByYear.set(leaseYear, escalatedRent);
      }
    }

    // Store year 0 rent for reference
    if (!escalatedRentByYear.has(0)) {
      escalatedRentByYear.set(0, baseRent);
    }

    // Count escalation events (first month of each new lease year > 0)
    if (leaseYear > 0 && escalationRate > 0) {
      const prevMonth = months[months.indexOf(month) - 1];
      if (prevMonth) {
        const prevLeaseYear = getLeaseYear(lease.start_date, prevMonth);
        if (leaseYear > prevLeaseYear) {
          escalationCount++;
        }
      }
    }

    // CAM charge calculation
    let camCharge = rawMonthlyCam;
    if (camCap != null && camCharge > camCap) {
      camCharge = camCap;
    }

    // Base year expense recovery adjustment
    let recoveryAdjustment = 0;
    if (baseYear != null && expenseRecoveryMethod === "base_year" && baseYearAmount > 0) {
      // Simplified: current year expenses come from config_values.current_year_expenses
      // or we assume a simple model where recovery = current - base prorated monthly
      const currentYearExpenses = Number(configValues.current_year_expenses ?? 0);
      if (currentYearExpenses > baseYearAmount) {
        recoveryAdjustment = Math.round(((currentYearExpenses - baseYearAmount) / 12) * 100) / 100;
      }
    }

    const monthTotal = Math.round((escalatedRent + camCharge + recoveryAdjustment) * 100) / 100;
    totalRent += monthTotal;

    rentSchedule.push({
      month,
      base_rent: baseRent,
      escalated_rent: Math.round(escalatedRent * 100) / 100,
      cam_charge: Math.round(camCharge * 100) / 100,
      total_rent: monthTotal,
    });
  }

  totalRent = Math.round(totalRent * 100) / 100;
  const avgMonthlyRent = months.length > 0 ? Math.round((totalRent / months.length) * 100) / 100 : 0;

  return {
    error: false,
    lease_id: lease.id,
    rent_schedule: rentSchedule,
    summary: {
      total_rent: totalRent,
      avg_monthly_rent: avgMonthlyRent,
      term_months: months.length,
      escalation_count: escalationCount,
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

    const body = await req.json();
    const { lease_id, property_id } = body;

    if (!lease_id && !property_id) {
      throw new Error("Request must include lease_id or property_id");
    }

    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview", "RentProjection"], "write");
    await assertPropertyAccess(req, property_id ?? null);

    // ----------------------------------------------------------------
    // 1. Fetch lease(s) scoped to the user's organization
    // ----------------------------------------------------------------
    let leases: Record<string, any>[] = [];

    if (lease_id) {
      const { data, error } = await supabaseAdmin
        .from("leases")
        .select("*")
        .eq("id", lease_id)
        .eq("org_id", orgId);

      if (error) throw new Error(`Failed to fetch lease: ${error.message}`);
      if (!data || data.length === 0) throw new Error(`Lease ${lease_id} not found`);
      leases = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from("leases")
        .select("*")
        .eq("property_id", property_id)
        .eq("org_id", orgId);

      if (error) throw new Error(`Failed to fetch leases: ${error.message}`);
      if (!data || data.length === 0) throw new Error(`No leases found for property ${property_id}`);
      leases = data;
    }

    // ----------------------------------------------------------------
    // 2. Fetch lease_config for all leases (batch)
    // ----------------------------------------------------------------
    const leaseIds = leases.map((l) => l.id);
    const { data: leaseConfigs } = await supabaseAdmin
      .from("lease_config")
      .select("*")
      .in("lease_id", leaseIds)
      .eq("org_id", orgId);

    const leaseConfigMap: Record<string, Record<string, any>> = {};
    if (leaseConfigs) {
      for (const lc of leaseConfigs) {
        leaseConfigMap[lc.lease_id] = lc;
      }
    }

    // ----------------------------------------------------------------
    // 3. Fetch property_config for the relevant properties
    // ----------------------------------------------------------------
    const propertyIds = [...new Set(leases.map((l) => l.property_id).filter(Boolean))];
    let propertyConfigMap: Record<string, Record<string, any>> = {};

    if (propertyIds.length > 0) {
      const { data: propertyConfigs } = await supabaseAdmin
        .from("property_config")
        .select("*")
        .in("property_id", propertyIds)
        .eq("org_id", orgId);

      if (propertyConfigs) {
        for (const pc of propertyConfigs) {
          propertyConfigMap[pc.property_id] = pc;
        }
      }
    }

    // ----------------------------------------------------------------
    // 4. Compute each lease
    // ----------------------------------------------------------------
    const results: LeaseResult[] = [];

    for (const lease of leases) {
      const leaseConf = leaseConfigMap[lease.id] ?? null;
      const propConf = lease.property_id ? (propertyConfigMap[lease.property_id] ?? null) : null;
      const result = computeLeaseSchedule(lease, leaseConf, propConf);
      results.push(result);

    }

    // ----------------------------------------------------------------
    // 6. Build property-level aggregate snapshot (for RentProjection UI)
    //    Only when called with property_id (multi-lease mode)
    // ----------------------------------------------------------------
    if (property_id) {
      const successResults = results.filter((r) => !r.error);

      if (successResults.length > 0) {
        const fiscalYear = body.fiscal_year ?? new Date().getFullYear();

        // Build tenant_schedules — one entry per lease
        const tenantSchedules = successResults.map((r) => {
          const lease = leases.find((l) => l.id === r.lease_id)!;
          const summary = r.summary!;
          // Find the current-year monthly rent from the schedule
          const currentYearMonths = (r.rent_schedule ?? []).filter((m) =>
            m.month.startsWith(String(fiscalYear))
          );
          const avgMonthly =
            currentYearMonths.length > 0
              ? Math.round(
                  currentYearMonths.reduce((s, m) => s + m.escalated_rent, 0) /
                    currentYearMonths.length
                )
              : Math.round(summary.avg_monthly_rent);

          const nextYearMonths = (r.rent_schedule ?? []).filter((m) =>
            m.month.startsWith(String(fiscalYear + 1))
          );
          const projectedMonthly =
            nextYearMonths.length > 0
              ? Math.round(
                  nextYearMonths.reduce((s, m) => s + m.escalated_rent, 0) /
                    nextYearMonths.length
                )
              : Math.round(avgMonthly * 1.03); // fallback: 3% escalation

          const leaseConf = leaseConfigMap[lease.id] ?? null;
          const escalationType =
            leaseConf?.config_values?.escalation_type ?? "none";
          const escalationRate =
            leaseConf?.config_values?.escalation_rate ?? 0;

          // CAM charge: average of current-year cam_charge entries
          const avgCam =
            currentYearMonths.length > 0
              ? Math.round(
                  currentYearMonths.reduce((s, m) => s + m.cam_charge, 0) /
                    currentYearMonths.length
                )
              : 0;

          return {
            lease_id: lease.id,
            tenant_name: lease.tenant_name ?? "Unknown",
            lease_type: lease.lease_type ?? "unknown",
            square_footage: Number(lease.square_footage) || 0,
            rent_per_sf:
              Number(lease.square_footage) > 0
                ? Math.round((avgMonthly / Number(lease.square_footage)) * 12 * 100) / 100
                : 0,
            monthly_rent: avgMonthly,
            cam_charge: avgCam,
            total_rent: avgMonthly + avgCam,
            projected_monthly: projectedMonthly,
            escalation_type: escalationType,
            escalation_rate: escalationRate,
          };
        });

        // Build monthly_projections — aggregate across all leases for each month 1–12
        const monthlyProjections = Array.from({ length: 12 }, (_, i) => {
          const monthNum = i + 1;
          const monthStr = `${fiscalYear}-${String(monthNum).padStart(2, "0")}`;
          const prevMonthStr = `${fiscalYear - 1}-${String(monthNum).padStart(2, "0")}`;
          const nextMonthStr = `${fiscalYear + 1}-${String(monthNum).padStart(2, "0")}`;

          let baseRent = 0;
          let projectedRent = 0;
          let previousRent = 0;

          for (const r of successResults) {
            const schedule = r.rent_schedule ?? [];
            const cur = schedule.find((m) => m.month === monthStr);
            const nxt = schedule.find((m) => m.month === nextMonthStr);
            const prv = schedule.find((m) => m.month === prevMonthStr);
            if (cur) {
              baseRent += cur.escalated_rent;
              projectedRent += nxt ? nxt.escalated_rent : cur.escalated_rent * 1.03;
              previousRent += prv ? prv.escalated_rent : 0;
            }
          }

          return {
            month: monthNum,
            base_rent: Math.round(baseRent),
            projected_rent: Math.round(projectedRent),
            previous_rent: Math.round(previousRent),
            budget_rent: 0, // filled by compute-budget
          };
        });

        // Build summary
        const totalCurrentAnnual = monthlyProjections.reduce(
          (s, m) => s + m.base_rent,
          0
        );
        const totalProjectedAnnual = monthlyProjections.reduce(
          (s, m) => s + m.projected_rent,
          0
        );
        const totalPrevAnnual = monthlyProjections.reduce(
          (s, m) => s + m.previous_rent,
          0
        );
        const avgMonthlyRent = Math.round(totalCurrentAnnual / 12);
        const avgProjectedMonthly = Math.round(totalProjectedAnnual / 12);
        const avgPreviousMonthly = Math.round(totalPrevAnnual / 12);

        const aggregateOutputs = {
          tenant_schedules: tenantSchedules,
          monthly_projections: monthlyProjections,
          summary: {
            total_rent: totalCurrentAnnual,
            total_projected_rent: totalProjectedAnnual,
            avg_monthly_rent: avgMonthlyRent,
            avg_projected_monthly: avgProjectedMonthly,
            avg_previous_monthly: avgPreviousMonthly,
            lease_count: successResults.length,
          },
        };

        const snapshotInputs = {
          property_id,
          fiscal_year: fiscalYear,
          lease_count: leases.length,
          _compute: {
            page_scope: ["Leases", "LeaseUpload", "LeaseReview", "RentProjection"],
            source_tables: ["leases", "lease_config", "property_config"],
            source_row_ids: {
              leases: leases.map((lease) => lease.id).sort(),
              lease_configs: Object.keys(leaseConfigMap).sort(),
              property_configs: Object.keys(propertyConfigMap).sort(),
            },
            source_counts: {
              leases: leases.length,
              lease_configs: Object.keys(leaseConfigMap).length,
              property_configs: Object.keys(propertyConfigMap).length,
            },
            trigger_type: req.headers.get("x-compute-trigger") ?? "manual",
            source_file_id: req.headers.get("x-source-file-id") ?? null,
          },
        };

        const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
          org_id: orgId,
          property_id,
          engine_type: "lease",
          fiscal_year: fiscalYear,
          computed_by: user.email ?? user.id,
          inputs: snapshotInputs,
          outputs: aggregateOutputs,
        });

        if (existingSnapshot?.outputs) {
          return new Response(
            JSON.stringify({
              error: false,
              property_id,
              results,
              snapshot_id: existingSnapshot.id,
              reused_snapshot: true,
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        await saveSnapshot(supabaseAdmin, {
          org_id: orgId,
          property_id,
          engine_type: "lease",
          fiscal_year: fiscalYear,
          computed_by: user.email ?? user.id,
          inputs: snapshotInputs,
          outputs: aggregateOutputs,
        });
      }
    }

    // ----------------------------------------------------------------
    // 7. Build response
    // ----------------------------------------------------------------
    if (lease_id) {
      // Single lease mode — return flat object
      const result = results[0];
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Multi-lease mode (property_id) — return array
    return new Response(JSON.stringify({ error: false, property_id, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[compute-lease] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
