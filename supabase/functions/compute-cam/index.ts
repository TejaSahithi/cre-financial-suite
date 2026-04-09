// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { saveSnapshot } from "../_shared/snapshot.ts";
import { calculateCam } from "../_shared/cam-calculator.ts";

type ScopeLevel = "property" | "building" | "unit";

async function fetchPropertyContext(supabaseAdmin: any, orgId: string, propertyId: string) {
  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties")
    .select("*")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .single();

  if (propertyError || !property) {
    throw new Error(`Property not found: ${propertyError?.message ?? propertyId}`);
  }

  const [{ data: buildings, error: buildingError }, { data: units, error: unitError }] = await Promise.all([
    supabaseAdmin
      .from("buildings")
      .select("*")
      .eq("property_id", propertyId)
      .eq("org_id", orgId),
    supabaseAdmin
      .from("units")
      .select("*")
      .eq("property_id", propertyId)
      .eq("org_id", orgId),
  ]);

  if (buildingError) throw new Error(`Failed to fetch buildings: ${buildingError.message}`);
  if (unitError) throw new Error(`Failed to fetch units: ${unitError.message}`);

  return { property, buildings: buildings ?? [], units: units ?? [] };
}

async function fetchExpenses(supabaseAdmin: any, orgId: string, propertyId: string, fiscalYear: number) {
  const { data, error } = await supabaseAdmin
    .from("expenses")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("fiscal_year", fiscalYear);

  if (error) throw new Error(`Failed to fetch expenses: ${error.message}`);
  return data ?? [];
}

async function fetchLeases(supabaseAdmin: any, orgId: string, propertyId: string) {
  const { data, error } = await supabaseAdmin
    .from("leases")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId);

  if (error) throw new Error(`Failed to fetch leases: ${error.message}`);
  return data ?? [];
}

async function fetchConfigs(supabaseAdmin: any, orgId: string, propertyId: string, leaseIds: string[]) {
  const { data: propertyConfig, error: propertyConfigError } = await supabaseAdmin
    .from("property_config")
    .select("*")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (propertyConfigError) {
    throw new Error(`Failed to fetch property_config: ${propertyConfigError.message}`);
  }

  let leaseConfigMap: Record<string, Record<string, unknown>> = {};
  if (leaseIds.length) {
    const { data: leaseConfigs, error: leaseConfigError } = await supabaseAdmin
      .from("lease_config")
      .select("*")
      .eq("org_id", orgId)
      .in("lease_id", leaseIds);

    if (leaseConfigError) {
      throw new Error(`Failed to fetch lease_config: ${leaseConfigError.message}`);
    }

    leaseConfigMap = Object.fromEntries((leaseConfigs ?? []).map((row: any) => [row.lease_id, row]));
  }

  return { propertyConfig, leaseConfigMap };
}

function collectHistoricalYears(
  fiscalYear: number,
  leaseConfigMap: Record<string, Record<string, unknown>>,
) {
  const years = new Set<number>([fiscalYear - 1]);

  for (const config of Object.values(leaseConfigMap)) {
    const values = config?.config_values ?? {};
    const baseYear = Number(config?.base_year ?? values.base_year ?? 0);
    const nonCumulativeYear = Number(values.non_cumulative_cap_base_year ?? 0);

    if (baseYear > 1900) years.add(baseYear);
    if (nonCumulativeYear > 1900) years.add(nonCumulativeYear);
  }

  return Array.from(years).sort((a, b) => a - b);
}

function buildHistoricalIndex(snapshotRows: any[]) {
  const byYear: Record<string, Record<string, any>> = {};
  const latestByYear = new Map<number, any>();

  for (const row of snapshotRows ?? []) {
    const year = Number(row.fiscal_year);
    if (!latestByYear.has(year)) {
      latestByYear.set(year, row);
    }
  }

  for (const [year, row] of latestByYear.entries()) {
    const index: Record<string, any> = {};
    for (const tenantCharge of row?.outputs?.tenant_charges ?? []) {
      if (tenantCharge?.lease_id) {
        index[tenantCharge.lease_id] = tenantCharge;
      }
    }
    byYear[String(year)] = index;
  }

  return byYear;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const body = await req.json();
    const propertyId = body?.property_id;
    const fiscalYear = Number(body?.fiscal_year);
    const scopeLevel = (body?.scope_level ?? "property") as ScopeLevel;
    const scopeId = scopeLevel === "property" ? propertyId : body?.scope_id;

    if (!propertyId || !Number.isFinite(fiscalYear)) {
      throw new Error("property_id and fiscal_year are required");
    }

    if ((scopeLevel === "building" || scopeLevel === "unit") && !scopeId) {
      throw new Error(`scope_id is required when scope_level is ${scopeLevel}`);
    }

    const { property, buildings, units } = await fetchPropertyContext(supabaseAdmin, orgId, propertyId);
    const [expenses, leases] = await Promise.all([
      fetchExpenses(supabaseAdmin, orgId, propertyId, fiscalYear),
      fetchLeases(supabaseAdmin, orgId, propertyId),
    ]);

    const leaseIds = leases.map((lease: any) => lease.id);
    const { propertyConfig, leaseConfigMap } = await fetchConfigs(
      supabaseAdmin,
      orgId,
      propertyId,
      leaseIds,
    );

    const historicalYears = collectHistoricalYears(fiscalYear, leaseConfigMap);
    const { data: historicalSnapshots, error: historicalError } = await supabaseAdmin
      .from("computation_snapshots")
      .select("fiscal_year, outputs, computed_at")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .in("fiscal_year", historicalYears)
      .order("computed_at", { ascending: false });

    if (historicalError) {
      throw new Error(`Failed to fetch historical CAM snapshots: ${historicalError.message}`);
    }

    const calculation = calculateCam({
      fiscal_year: fiscalYear,
      scope_level: scopeLevel,
      scope_id: scopeId,
      property: {
        id: property.id,
        name: property.name,
        total_sqft: property.total_sqft,
      },
      buildings,
      units,
      expenses,
      leases,
      property_config: propertyConfig,
      lease_configs: leaseConfigMap,
      historical_by_year: buildHistoricalIndex(historicalSnapshots ?? []),
    });

    const { data: budgetSnapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("outputs")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "budget")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1);

    const { data: priorCamSnapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("outputs")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .eq("fiscal_year", fiscalYear - 1)
      .order("computed_at", { ascending: false })
      .limit(1);

    const totalCam = calculation.tenant_charges.reduce(
      (sum: number, row: any) => sum + (Number(row.annual_cam) || 0),
      0,
    );
    const denominatorSqft = calculation.pools?.property_pool?.metrics?.occupied_area
      || property.total_sqft
      || 0;
    const camPerSf = denominatorSqft > 0 ? totalCam / Number(denominatorSqft) : 0;

    const { error: camCalculationError } = await supabaseAdmin
      .from("cam_calculations")
      .upsert(
        {
          org_id: orgId,
          property_id: propertyId,
          fiscal_year: fiscalYear,
          annual_cam: round2(totalCam),
          cam_per_sf: round2(camPerSf),
          method: propertyConfig?.cam_calculation_method ?? "pro_rata",
          status: "computed",
          admin_fee_pct: Number(propertyConfig?.config_values?.admin_fee_pct ?? 0),
          gross_up_pct: Number(propertyConfig?.config_values?.gross_up_target_occupancy_pct ?? 0),
          cap_pct: 0,
          total_recoverable: calculation.summary.total_recoverable,
          total_building_sf: Number(denominatorSqft) || 0,
          notes: calculation.assumptions.join(" | "),
        },
        { onConflict: "org_id,property_id,fiscal_year" },
      );

    if (camCalculationError) {
      console.error("[compute-cam] cam_calculations upsert failed:", camCalculationError.message);
    }

    const outputs = {
      ...calculation.summary,
      total_cam: round2(totalCam),
      cam_per_sf: round2(camPerSf),
      prev_year_total: round2(Number(priorCamSnapshot?.[0]?.outputs?.total_cam ?? 0)),
      budgeted_cam: round2(
        Number(budgetSnapshot?.[0]?.outputs?.line_items?.revenue?.cam_recovery ?? 0),
      ),
      tenant_charges: calculation.tenant_charges,
      assumptions: calculation.assumptions,
      scope_level: scopeLevel,
      scope_id: scopeId,
    };

    const inputs = {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      scope_level: scopeLevel,
      scope_id: scopeId,
      lease_count: leases.length,
      expense_count: expenses.length,
      building_count: buildings.length,
      unit_count: units.length,
      property_config: propertyConfig,
    };

    await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: "cam",
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      inputs,
      outputs,
    });

    return new Response(
      JSON.stringify({
        error: false,
        property_id: propertyId,
        fiscal_year: fiscalYear,
        scope_level: scopeLevel,
        scope_id: scopeId,
        ...outputs,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[compute-cam] Error:", err?.message || err);
    return new Response(
      JSON.stringify({ error: true, message: err?.message || "Unexpected error" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
