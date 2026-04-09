// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { saveSnapshot } from "../_shared/snapshot.ts";

/**
 * Compute CAM Edge Function — multi-level
 *
 * Computes Common Area Maintenance charges at one of three levels:
 *   - "property": classic — pool all property expenses, allocate across all
 *                 active leases on the property by sqft / fixed / percentage.
 *   - "building": pool only expenses scoped to a building (or expenses for
 *                 the parent property if `expenses.building_id` is null),
 *                 then allocate across leases tied to units in that building.
 *   - "unit":     directly bills the lease tied to a single unit. Pool is the
 *                 unit's directly-attributed expenses (expenses.unit_id) plus
 *                 a pro-rata slice of building/property-level recoverables.
 *
 * Body:
 *   {
 *     scope_level?: "property" | "building" | "unit",   // default "property"
 *     scope_id?: string,                                // id of the scope target
 *     property_id: string,                              // ALWAYS required (parent)
 *     fiscal_year: number
 *   }
 *
 * For backwards compatibility, if scope_level/scope_id are omitted the call
 * behaves exactly like the old property-level compute.
 */

type ScopeLevel = "property" | "building" | "unit";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const body = await req.json();
    const {
      property_id,
      fiscal_year,
      scope_level: rawScopeLevel,
      scope_id: rawScopeId,
    } = body ?? {};

    if (!property_id || !fiscal_year) {
      throw new Error("property_id and fiscal_year are required");
    }

    const scopeLevel: ScopeLevel = (
      rawScopeLevel === "unit" || rawScopeLevel === "building"
        ? rawScopeLevel
        : "property"
    );
    const scopeId: string | null =
      scopeLevel === "property" ? property_id : (rawScopeId ?? null);

    if (scopeLevel !== "property" && !scopeId) {
      throw new Error(`scope_id is required when scope_level = ${scopeLevel}`);
    }

    // ---------------------------------------------------------------
    // 1. Fetch property + property_config (always needed for the pool)
    // ---------------------------------------------------------------
    const { data: property, error: propErr } = await supabaseAdmin
      .from("properties")
      .select("id, total_sqft, org_id, name")
      .eq("id", property_id)
      .eq("org_id", orgId)
      .single();

    if (propErr || !property) {
      throw new Error(`Property not found: ${propErr?.message ?? property_id}`);
    }

    const { data: propertyConfig } = await supabaseAdmin
      .from("property_config")
      .select("cam_calculation_method, config_values")
      .eq("property_id", property_id)
      .maybeSingle();

    const camMethod = propertyConfig?.cam_calculation_method ?? "pro_rata";
    const propConfigValues = propertyConfig?.config_values ?? {};
    const adminFeePct = Number(propConfigValues.admin_fee_pct ?? 10);
    const grossUpPct = Number(propConfigValues.gross_up_pct ?? 0);
    const capPct = propConfigValues.cap_pct != null ? Number(propConfigValues.cap_pct) : null;

    // ---------------------------------------------------------------
    // 2. Resolve scope target metadata (building / unit)
    // ---------------------------------------------------------------
    let scopeRecord: any = null;
    let scopeSf = 0;

    if (scopeLevel === "building") {
      const { data: building, error: bErr } = await supabaseAdmin
        .from("buildings")
        .select("id, name, total_sqft, property_id, org_id")
        .eq("id", scopeId)
        .eq("org_id", orgId)
        .single();
      if (bErr || !building) {
        throw new Error(`Building not found: ${bErr?.message ?? scopeId}`);
      }
      if (building.property_id !== property_id) {
        throw new Error("Building does not belong to the specified property");
      }
      scopeRecord = building;
      scopeSf = Number(building.total_sqft) || 0;
    } else if (scopeLevel === "unit") {
      const { data: unit, error: uErr } = await supabaseAdmin
        .from("units")
        .select("id, unit_number, square_footage, property_id, building_id, org_id")
        .eq("id", scopeId)
        .eq("org_id", orgId)
        .single();
      if (uErr || !unit) {
        throw new Error(`Unit not found: ${uErr?.message ?? scopeId}`);
      }
      if (unit.property_id !== property_id) {
        throw new Error("Unit does not belong to the specified property");
      }
      scopeRecord = unit;
      scopeSf = Number(unit.square_footage) || 0;
    }

    // ---------------------------------------------------------------
    // 3. Fetch recoverable expenses for the scope
    //
    // We try the scoped query first; if `expenses.building_id` /
    // `expenses.unit_id` columns don't exist on the deployed DB
    // (older migration), we transparently fall back to property-level
    // expenses so the call still succeeds.
    // ---------------------------------------------------------------
    const fetchExpensesForScope = async () => {
      // Always include property-level rows in the candidate set so the
      // building/unit queries don't return empty when expenses haven't
      // been tagged with the new hierarchy columns yet.
      let query = supabaseAdmin
        .from("expenses")
        .select("id, category, amount, classification, is_controllable, property_id, building_id, unit_id")
        .eq("property_id", property_id)
        .eq("org_id", orgId)
        .eq("fiscal_year", fiscal_year);

      const { data, error } = await query;
      if (error) {
        const msg = String(error.message ?? "");
        if (/column .* does not exist/i.test(msg) || error.code === "42703") {
          // Older schema — building_id/unit_id not present. Re-query without them.
          const { data: legacy, error: legacyErr } = await supabaseAdmin
            .from("expenses")
            .select("id, category, amount, classification, is_controllable, property_id")
            .eq("property_id", property_id)
            .eq("org_id", orgId)
            .eq("fiscal_year", fiscal_year);
          if (legacyErr) {
            throw new Error(`Failed to fetch expenses: ${legacyErr.message}`);
          }
          return (legacy ?? []).map((e: any) => ({ ...e, building_id: null, unit_id: null }));
        }
        throw new Error(`Failed to fetch expenses: ${msg}`);
      }
      return data ?? [];
    };

    const allExpenses = await fetchExpensesForScope();

    // Only recoverable / controllable rows feed the CAM pool.
    const recoverableExpenses = allExpenses.filter((e: any) =>
      e.classification === "recoverable" || e.is_controllable === true
    );

    // Slice expenses by scope
    let scopedExpenses: any[] = [];
    let directExpenses: any[] = []; // direct-billed for unit scope
    if (scopeLevel === "property") {
      scopedExpenses = recoverableExpenses;
    } else if (scopeLevel === "building") {
      scopedExpenses = recoverableExpenses.filter(
        (e: any) => e.building_id === scopeId || e.building_id == null,
      );
    } else if (scopeLevel === "unit") {
      // Unit-direct rows = pure pass-through (utilities, sub-metered, etc.)
      directExpenses = recoverableExpenses.filter((e: any) => e.unit_id === scopeId);
      // The rest of the recoverable pool is shared across the building/property
      scopedExpenses = recoverableExpenses.filter((e: any) => e.unit_id == null);
    }

    // ---------------------------------------------------------------
    // 4. Fetch active leases for the scope
    // ---------------------------------------------------------------
    let leaseQuery = supabaseAdmin
      .from("leases")
      .select("id, tenant_name, square_footage, status, unit_id")
      .eq("property_id", property_id)
      .eq("org_id", orgId)
      .eq("status", "active");

    let { data: leasesRaw, error: leaseErr } = await leaseQuery;
    if (leaseErr) {
      // Tolerate older lease schemas without unit_id
      const msg = String(leaseErr.message ?? "");
      if (/unit_id/i.test(msg)) {
        const { data: legacy, error: legacyErr } = await supabaseAdmin
          .from("leases")
          .select("id, tenant_name, square_footage, status")
          .eq("property_id", property_id)
          .eq("org_id", orgId)
          .eq("status", "active");
        if (legacyErr) throw new Error(`Failed to fetch leases: ${legacyErr.message}`);
        leasesRaw = (legacy ?? []).map((l: any) => ({ ...l, unit_id: null }));
      } else {
        throw new Error(`Failed to fetch leases: ${leaseErr.message}`);
      }
    }
    leasesRaw = leasesRaw ?? [];

    // Filter leases by scope
    let leases: any[] = [];
    if (scopeLevel === "property") {
      leases = leasesRaw;
    } else if (scopeLevel === "building") {
      // Need to know which units belong to the building
      const { data: bldgUnits, error: uErr } = await supabaseAdmin
        .from("units")
        .select("id")
        .eq("building_id", scopeId)
        .eq("org_id", orgId);
      if (uErr) throw new Error(`Failed to fetch building units: ${uErr.message}`);
      const unitSet = new Set((bldgUnits ?? []).map((u: any) => u.id));
      leases = leasesRaw.filter((l: any) => l.unit_id && unitSet.has(l.unit_id));
    } else if (scopeLevel === "unit") {
      leases = leasesRaw.filter((l: any) => l.unit_id === scopeId);
    }

    if (!leases.length) {
      throw new Error(
        `No active leases found for ${scopeLevel} scope ${scopeId ?? property_id}`,
      );
    }

    // Fetch lease_config for every active lease in scope
    const leaseIds = leases.map((l: any) => l.id);
    const { data: leaseConfigs, error: lcErr } = await supabaseAdmin
      .from("lease_config")
      .select("lease_id, cam_cap, excluded_expenses, config_values")
      .in("lease_id", leaseIds);

    if (lcErr) {
      throw new Error(`Failed to fetch lease configs: ${lcErr.message}`);
    }

    const leaseConfigMap: Record<string, any> = {};
    for (const lc of leaseConfigs ?? []) {
      leaseConfigMap[lc.lease_id] = lc;
    }

    // ---------------------------------------------------------------
    // 5. Determine the CAM pool denominator (sqft) for this scope
    // ---------------------------------------------------------------
    const totalPropertySf = Number(property.total_sqft) || 0;
    if (totalPropertySf <= 0) {
      throw new Error("Property total_sqft must be greater than zero");
    }

    let denominatorSf: number;
    if (scopeLevel === "property") {
      denominatorSf = totalPropertySf;
    } else if (scopeLevel === "building") {
      denominatorSf = scopeSf > 0 ? scopeSf : totalPropertySf;
    } else {
      denominatorSf = scopeSf > 0 ? scopeSf : totalPropertySf;
    }

    // ---------------------------------------------------------------
    // 6. Build the CAM pool: shared recoverables + admin fee + gross-up + cap
    // ---------------------------------------------------------------
    const totalRecoverable = scopedExpenses.reduce(
      (sum: number, e: any) => sum + (Number(e.amount) || 0),
      0,
    );
    const totalDirect = directExpenses.reduce(
      (sum: number, e: any) => sum + (Number(e.amount) || 0),
      0,
    );

    let totalCam = totalRecoverable * (1 + adminFeePct / 100);

    // Occupancy / gross-up — use leases in scope vs denominator
    const occupiedSf = leases.reduce(
      (sum: number, l: any) => sum + (Number(l.square_footage) || 0),
      0,
    );
    const occupancyRate = denominatorSf > 0 ? occupiedSf / denominatorSf : 0;

    if (occupancyRate < 1 && grossUpPct > 0) {
      const variablePortion = totalCam * (grossUpPct / 100);
      const fixedPortion = totalCam - variablePortion;
      const grossedUpVariable =
        occupancyRate > 0 ? variablePortion / occupancyRate : variablePortion;
      totalCam = fixedPortion + grossedUpVariable;
    }

    if (capPct !== null && capPct > 0) {
      const capAmount = totalRecoverable * (capPct / 100);
      if (totalCam > capAmount) totalCam = capAmount;
    }

    // Direct-billed (unit-scope) sits OUTSIDE the gross-up / admin fee math
    totalCam += totalDirect;

    const camPerSf = denominatorSf > 0 ? totalCam / denominatorSf : 0;

    // ---------------------------------------------------------------
    // 7. Allocate CAM to each lease in scope
    // ---------------------------------------------------------------
    const tenantCharges: any[] = [];
    let totalBilled = 0;

    for (const lease of leases) {
      const lc = leaseConfigMap[lease.id] ?? {};
      const tenantSf = Number(lease.square_footage) || 0;
      const excludedCategories: string[] = lc.excluded_expenses ?? [];
      const lcConfigValues = lc.config_values ?? {};

      // Tenant-specific recoverable (subtract excluded categories)
      let tenantRecoverable = totalRecoverable;
      if (excludedCategories.length > 0) {
        tenantRecoverable = scopedExpenses.reduce(
          (sum: number, e: any) =>
            excludedCategories.includes(e.category) ? sum : sum + (Number(e.amount) || 0),
          0,
        );
      }

      let tenantCamPool = tenantRecoverable * (1 + adminFeePct / 100);

      if (occupancyRate < 1 && grossUpPct > 0) {
        const variablePortion = tenantCamPool * (grossUpPct / 100);
        const fixedPortion = tenantCamPool - variablePortion;
        const grossedUpVariable =
          occupancyRate > 0 ? variablePortion / occupancyRate : variablePortion;
        tenantCamPool = fixedPortion + grossedUpVariable;
      }

      let tenantCam = 0;
      let proRataShare = 0;

      switch (camMethod) {
        case "pro_rata": {
          proRataShare = denominatorSf > 0 ? tenantSf / denominatorSf : 0;
          tenantCam = tenantCamPool * proRataShare;
          break;
        }
        case "fixed": {
          const fixedAmount = lcConfigValues.fixed_cam_amount;
          if (fixedAmount !== undefined && fixedAmount !== null) {
            tenantCam = Number(fixedAmount);
          } else {
            tenantCam = tenantCamPool / leases.length;
          }
          proRataShare = denominatorSf > 0 ? tenantSf / denominatorSf : 0;
          break;
        }
        case "percentage":
        case "capped": {
          const pct = lcConfigValues.cam_percentage;
          if (pct !== undefined && pct !== null) {
            tenantCam = tenantCamPool * (Number(pct) / 100);
          } else {
            proRataShare = denominatorSf > 0 ? tenantSf / denominatorSf : 0;
            tenantCam = tenantCamPool * proRataShare;
          }
          proRataShare = tenantCamPool > 0 ? tenantCam / tenantCamPool : 0;
          break;
        }
        default: {
          proRataShare = denominatorSf > 0 ? tenantSf / denominatorSf : 0;
          tenantCam = tenantCamPool * proRataShare;
        }
      }

      // Add direct-billed expenses (unit scope only): the lease that owns the
      // unit absorbs 100% of its direct expenses on top of the pro-rata share.
      if (scopeLevel === "unit" && lease.unit_id === scopeId) {
        tenantCam += totalDirect;
      }

      let capApplied = false;
      if (lc.cam_cap !== undefined && lc.cam_cap !== null) {
        const capValue = Number(lc.cam_cap);
        if (tenantCam > capValue) {
          tenantCam = capValue;
          capApplied = true;
        }
      }

      tenantCam = Math.round(tenantCam * 100) / 100;
      proRataShare = Math.round(proRataShare * 10000) / 10000;
      totalBilled += tenantCam;

      tenantCharges.push({
        tenant_name: lease.tenant_name,
        lease_id: lease.id,
        unit_id: lease.unit_id,
        square_footage: tenantSf,
        pro_rata_share: proRataShare,
        cam_charge: tenantCam,
        monthly_cam: Math.round((tenantCam / 12) * 100) / 100,
        cap_applied: capApplied,
      });
    }

    // ---------------------------------------------------------------
    // 8. Reconciliation summary
    // ---------------------------------------------------------------
    totalBilled = Math.round(totalBilled * 100) / 100;
    const roundedTotalCam = Math.round(totalCam * 100) / 100;
    const roundedCamPerSf = Math.round(camPerSf * 100) / 100;
    const variance = Math.round((roundedTotalCam - totalBilled) * 100) / 100;

    const reconciliation = {
      total_recoverable: Math.round(totalRecoverable * 100) / 100,
      total_direct: Math.round(totalDirect * 100) / 100,
      total_billed: totalBilled,
      variance,
    };

    // ---------------------------------------------------------------
    // 9. Persist to cam_calculations and computation_snapshots
    // ---------------------------------------------------------------
    const camCalcPayload: any = {
      org_id: orgId,
      property_id,
      fiscal_year,
      annual_cam: roundedTotalCam,
      cam_per_sf: roundedCamPerSf,
      method: camMethod,
      status: "computed",
      admin_fee_pct: adminFeePct,
      gross_up_pct: grossUpPct,
      cap_pct: capPct,
      total_recoverable: Math.round(totalRecoverable * 100) / 100,
      total_building_sf: denominatorSf,
    };

    const { error: camInsertErr } = await supabaseAdmin
      .from("cam_calculations")
      .upsert(camCalcPayload, { onConflict: "org_id,property_id,fiscal_year" });

    if (camInsertErr) {
      console.error("[compute-cam] cam_calculations upsert error:", camInsertErr.message);
      // Fall back to plain insert in case the unique constraint isn't there
      await supabaseAdmin.from("cam_calculations").insert(camCalcPayload);
    }

    // Prior-year CAM total (for YoY) at the same scope
    let prevYearTotal = 0;
    {
      const { data: prevSnap } = await supabaseAdmin
        .from("computation_snapshots")
        .select("outputs")
        .eq("property_id", property_id)
        .eq("engine_type", "cam")
        .eq("fiscal_year", fiscal_year - 1)
        .order("computed_at", { ascending: false })
        .limit(1);
      if (prevSnap && prevSnap.length > 0) {
        prevYearTotal = Number(prevSnap[0].outputs?.total_cam ?? 0);
      }
    }

    // Budgeted CAM (revenue.cam_recovery from budget snapshot)
    let budgetedCam = 0;
    {
      const { data: budgetSnap } = await supabaseAdmin
        .from("computation_snapshots")
        .select("outputs")
        .eq("property_id", property_id)
        .eq("engine_type", "budget")
        .eq("fiscal_year", fiscal_year)
        .order("computed_at", { ascending: false })
        .limit(1);
      if (budgetSnap && budgetSnap.length > 0) {
        budgetedCam = Number(budgetSnap[0].outputs?.line_items?.revenue?.cam_recovery ?? 0);
      }
    }

    const inputs = {
      property_id,
      fiscal_year,
      scope_level: scopeLevel,
      scope_id: scopeId,
      cam_method: camMethod,
      admin_fee_pct: adminFeePct,
      gross_up_pct: grossUpPct,
      cap_pct: capPct,
      total_building_sf: totalPropertySf,
      denominator_sf: denominatorSf,
      occupancy_rate: Math.round(occupancyRate * 10000) / 10000,
      expense_count: scopedExpenses.length + directExpenses.length,
      lease_count: leases.length,
    };

    const outputs = {
      total_cam: roundedTotalCam,
      cam_per_sf: roundedCamPerSf,
      prev_year_total: Math.round(prevYearTotal * 100) / 100,
      budgeted_cam: Math.round(budgetedCam * 100) / 100,
      total_billed: totalBilled,
      method: camMethod,
      scope_level: scopeLevel,
      scope_id: scopeId,
      scope_label:
        scopeLevel === "property"
          ? property.name
          : scopeLevel === "building"
          ? scopeRecord?.name
          : scopeRecord?.unit_number,
      admin_fee_pct: adminFeePct,
      tenant_charges: tenantCharges,
      reconciliation,
    };

    await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id,
      engine_type: "cam",
      fiscal_year,
      computed_by: user.email ?? user.id,
      inputs,
      outputs,
    });

    // ---------------------------------------------------------------
    // Response
    // ---------------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        property_id,
        fiscal_year,
        scope_level: scopeLevel,
        scope_id: scopeId,
        total_cam: roundedTotalCam,
        cam_per_sf: roundedCamPerSf,
        method: camMethod,
        admin_fee_pct: adminFeePct,
        tenant_charges: tenantCharges,
        reconciliation,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[compute-cam] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
