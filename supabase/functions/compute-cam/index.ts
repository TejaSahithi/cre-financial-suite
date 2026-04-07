// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Compute CAM Edge Function
 * Applies CAM calculation methods per property
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 * Task: 10.1
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const { property_id, fiscal_year } = await req.json();
    if (!property_id || !fiscal_year) {
      throw new Error("property_id and fiscal_year are required");
    }

    // ---------------------------------------------------------------
    // 1. Fetch property and property_config
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

    const { data: propertyConfig } = await supabaseAdmin
      .from("property_config")
      .select("cam_calculation_method, config_values")
      .eq("property_id", property_id)
      .maybeSingle();

    const camMethod = propertyConfig?.cam_calculation_method ?? "pro_rata";
    const propConfigValues = propertyConfig?.config_values ?? {};
    const adminFeePct = propConfigValues.admin_fee_pct ?? 10;
    const grossUpPct = propConfigValues.gross_up_pct ?? 0;
    const capPct = propConfigValues.cap_pct ?? null;

    // ---------------------------------------------------------------
    // 2. Fetch all recoverable expenses for property + fiscal year
    // ---------------------------------------------------------------
    const { data: expenses, error: expErr } = await supabaseAdmin
      .from("expenses")
      .select("id, category, amount, classification, is_controllable")
      .eq("property_id", property_id)
      .eq("org_id", orgId)
      .eq("fiscal_year", fiscal_year)
      .or("classification.eq.recoverable,is_controllable.eq.true");

    if (expErr) {
      throw new Error(`Failed to fetch expenses: ${expErr.message}`);
    }

    // ---------------------------------------------------------------
    // 3. Fetch all active leases for the property
    // ---------------------------------------------------------------
    const { data: leases, error: leaseErr } = await supabaseAdmin
      .from("leases")
      .select("id, tenant_name, square_footage, status")
      .eq("property_id", property_id)
      .eq("org_id", orgId)
      .eq("status", "active");

    if (leaseErr) {
      throw new Error(`Failed to fetch leases: ${leaseErr.message}`);
    }

    if (!leases || leases.length === 0) {
      throw new Error("No active leases found for this property");
    }

    // Fetch lease_config for every active lease
    const leaseIds = leases.map((l: any) => l.id);
    const { data: leaseConfigs, error: lcErr } = await supabaseAdmin
      .from("lease_config")
      .select("lease_id, cam_cap, excluded_expenses, config_values")
      .in("lease_id", leaseIds);

    if (lcErr) {
      throw new Error(`Failed to fetch lease configs: ${lcErr.message}`);
    }

    // Index lease_config by lease_id for fast lookup
    const leaseConfigMap: Record<string, any> = {};
    if (leaseConfigs) {
      for (const lc of leaseConfigs) {
        leaseConfigMap[lc.lease_id] = lc;
      }
    }

    // ---------------------------------------------------------------
    // 4. Determine CAM calculation method (already resolved above)
    // ---------------------------------------------------------------

    // ---------------------------------------------------------------
    // 5. Calculate total CAM pool
    // ---------------------------------------------------------------
    const totalBuildingSf = Number(property.total_sqft) || 0;
    if (totalBuildingSf <= 0) {
      throw new Error("Property total_sqft must be greater than zero");
    }

    // Sum all recoverable expense amounts (base recoverable total)
    const totalRecoverable = (expenses ?? []).reduce(
      (sum: number, e: any) => sum + (Number(e.amount) || 0),
      0
    );

    // Apply admin fee
    let totalCam = totalRecoverable * (1 + adminFeePct / 100);

    // Calculate occupancy and apply gross-up if < 100%
    const occupiedSf = leases.reduce(
      (sum: number, l: any) => sum + (Number(l.square_footage) || 0),
      0
    );
    const occupancyRate = occupiedSf / totalBuildingSf;

    if (occupancyRate < 1 && grossUpPct > 0) {
      // Gross-up: adjust variable expenses to what they would be at full occupancy
      // The gross_up_pct indicates the percentage of expenses that are variable
      const variablePortion = totalCam * (grossUpPct / 100);
      const fixedPortion = totalCam - variablePortion;
      const grossedUpVariable =
        occupancyRate > 0 ? variablePortion / occupancyRate : variablePortion;
      totalCam = fixedPortion + grossedUpVariable;
    }

    // Apply property-level CAM cap percentage if configured
    if (capPct !== null && capPct > 0) {
      const capAmount = totalRecoverable * (capPct / 100);
      if (totalCam > capAmount) {
        totalCam = capAmount;
      }
    }

    const camPerSf = totalBuildingSf > 0 ? totalCam / totalBuildingSf : 0;

    // ---------------------------------------------------------------
    // 6 / 7 / 8. Calculate per-tenant charges
    // ---------------------------------------------------------------
    const tenantCharges: any[] = [];
    let totalBilled = 0;

    for (const lease of leases) {
      const lc = leaseConfigMap[lease.id] ?? {};
      const tenantSf = Number(lease.square_footage) || 0;
      const excludedCategories: string[] = lc.excluded_expenses ?? [];
      const lcConfigValues = lc.config_values ?? {};

      // Step 8: If this lease has excluded expense categories, compute a
      // tenant-specific recoverable total that omits those categories.
      let tenantRecoverable = totalRecoverable;
      if (excludedCategories.length > 0) {
        tenantRecoverable = (expenses ?? []).reduce(
          (sum: number, e: any) => {
            if (excludedCategories.includes(e.category)) return sum;
            return sum + (Number(e.amount) || 0);
          },
          0
        );
      }

      // Tenant-specific CAM pool (with admin fee applied to their recoverable)
      let tenantCamPool = tenantRecoverable * (1 + adminFeePct / 100);

      // Apply same gross-up logic to tenant-specific pool
      if (occupancyRate < 1 && grossUpPct > 0) {
        const variablePortion = tenantCamPool * (grossUpPct / 100);
        const fixedPortion = tenantCamPool - variablePortion;
        const grossedUpVariable =
          occupancyRate > 0
            ? variablePortion / occupancyRate
            : variablePortion;
        tenantCamPool = fixedPortion + grossedUpVariable;
      }

      // Step 6: Apply calculation method
      let tenantCam = 0;
      let proRataShare = 0;

      switch (camMethod) {
        case "pro_rata": {
          proRataShare = totalBuildingSf > 0 ? tenantSf / totalBuildingSf : 0;
          tenantCam = tenantCamPool * proRataShare;
          break;
        }
        case "fixed": {
          const fixedAmount = lcConfigValues.fixed_cam_amount;
          if (fixedAmount !== undefined && fixedAmount !== null) {
            tenantCam = Number(fixedAmount);
          } else {
            // Fallback: split evenly among all leases
            tenantCam = tenantCamPool / leases.length;
          }
          proRataShare = totalBuildingSf > 0 ? tenantSf / totalBuildingSf : 0;
          break;
        }
        case "percentage": {
          const pct = lcConfigValues.cam_percentage;
          if (pct !== undefined && pct !== null) {
            tenantCam = tenantCamPool * (Number(pct) / 100);
          } else {
            // Fallback to pro-rata when percentage not configured
            proRataShare =
              totalBuildingSf > 0 ? tenantSf / totalBuildingSf : 0;
            tenantCam = tenantCamPool * proRataShare;
          }
          proRataShare =
            tenantCamPool > 0 ? tenantCam / tenantCamPool : 0;
          break;
        }
        default: {
          // Default to pro_rata
          proRataShare = totalBuildingSf > 0 ? tenantSf / totalBuildingSf : 0;
          tenantCam = tenantCamPool * proRataShare;
        }
      }

      // Step 7: Apply CAM cap per lease
      let capApplied = false;
      if (lc.cam_cap !== undefined && lc.cam_cap !== null) {
        const capValue = Number(lc.cam_cap);
        if (tenantCam > capValue) {
          tenantCam = capValue;
          capApplied = true;
        }
      }

      // Round to two decimal places
      tenantCam = Math.round(tenantCam * 100) / 100;
      proRataShare = Math.round(proRataShare * 10000) / 10000; // 4 decimals

      totalBilled += tenantCam;

      tenantCharges.push({
        tenant_name: lease.tenant_name,
        lease_id: lease.id,
        square_footage: tenantSf,
        pro_rata_share: proRataShare,
        cam_charge: tenantCam,
        cap_applied: capApplied,
      });
    }

    // ---------------------------------------------------------------
    // 9. Generate CAM reconciliation summary
    // ---------------------------------------------------------------
    totalBilled = Math.round(totalBilled * 100) / 100;
    const roundedTotalCam = Math.round(totalCam * 100) / 100;
    const roundedCamPerSf = Math.round(camPerSf * 100) / 100;
    const variance = Math.round((roundedTotalCam - totalBilled) * 100) / 100;

    const reconciliation = {
      total_recoverable: Math.round(totalRecoverable * 100) / 100,
      total_billed: totalBilled,
      variance,
    };

    // ---------------------------------------------------------------
    // 10. Store results in cam_calculations AND computation_snapshots
    // ---------------------------------------------------------------
    const camCalcPayload = {
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
      total_building_sf: totalBuildingSf,
    };

    const { error: camInsertErr } = await supabaseAdmin
      .from("cam_calculations")
      .upsert(camCalcPayload, {
        onConflict: "org_id,property_id,fiscal_year",
      });

    if (camInsertErr) {
      console.error(
        "[compute-cam] cam_calculations upsert error:",
        camInsertErr.message
      );
      // Non-fatal: we still return the result even if storage fails.
      // Fall back to insert if upsert fails (in case there is no unique constraint).
      await supabaseAdmin.from("cam_calculations").insert(camCalcPayload);
    }

    // ---------------------------------------------------------------
    // Fetch prior-year CAM total and budgeted CAM for dashboard metrics
    // ---------------------------------------------------------------
    let prevYearTotal = 0;
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

    let budgetedCam = 0;
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

    const snapshotPayload = {
      org_id: orgId,
      property_id,
      engine_type: "cam",
      fiscal_year,
      computed_at: new Date().toISOString(),
      computed_by: user.email ?? user.id,
      inputs: {
        property_id,
        fiscal_year,
        cam_method: camMethod,
        admin_fee_pct: adminFeePct,
        gross_up_pct: grossUpPct,
        cap_pct: capPct,
        total_building_sf: totalBuildingSf,
        occupancy_rate: Math.round(occupancyRate * 10000) / 10000,
        expense_count: (expenses ?? []).length,
        lease_count: leases.length,
      },
      outputs: {
        total_cam: roundedTotalCam,
        cam_per_sf: roundedCamPerSf,
        prev_year_total: Math.round(prevYearTotal * 100) / 100,
        budgeted_cam: Math.round(budgetedCam * 100) / 100,
        total_billed: Math.round(totalBilled * 100) / 100,
        method: camMethod,
        admin_fee_pct: adminFeePct,
        tenant_charges: tenantCharges,
        reconciliation,
      },
      status: "completed",
    };

    const { error: snapErr } = await supabaseAdmin
      .from("computation_snapshots")
      .upsert(snapshotPayload, { onConflict: "org_id,property_id,engine_type,fiscal_year" });

    if (snapErr) {
      console.error("[compute-cam] computation_snapshots upsert error:", snapErr.message);
      // Fallback to insert if upsert fails (e.g. unique index not yet applied)
      await supabaseAdmin.from("computation_snapshots").insert(snapshotPayload).catch(() => {});
    }

    // ---------------------------------------------------------------
    // Response
    // ---------------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        property_id,
        fiscal_year,
        total_cam: roundedTotalCam,
        cam_per_sf: roundedCamPerSf,
        method: camMethod,
        admin_fee_pct: adminFeePct,
        tenant_charges: tenantCharges,
        reconciliation,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[compute-cam] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
