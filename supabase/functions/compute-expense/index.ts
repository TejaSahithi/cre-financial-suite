// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";

/**
 * Compute Expense Edge Function
 * Classifies expenses and allocates recoverable expenses across tenants.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.6
 * Task: 9.1
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const { property_id, fiscal_year } = await req.json();
    if (!property_id || !fiscal_year) {
      throw new Error("Missing required fields: property_id and fiscal_year");
    }

    await assertPageAccess(req, orgId, ["Expenses", "AddExpense", "BulkImport"], "write");
    await assertPropertyAccess(req, property_id);

    // ---------------------------------------------------------------
    // 1. Fetch all expenses for property_id & fiscal_year (org-scoped)
    // ---------------------------------------------------------------
    const { data: expenses, error: expErr } = await supabaseAdmin
      .from("expenses")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year);

    if (expErr) throw new Error(`Failed to fetch expenses: ${expErr.message}`);

    // ---------------------------------------------------------------
    // 2. Fetch all active leases for the property
    // ---------------------------------------------------------------
    const { data: leases, error: leaseErr } = await supabaseAdmin
      .from("leases")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("status", "active");

    if (leaseErr) throw new Error(`Failed to fetch leases: ${leaseErr.message}`);

    // ---------------------------------------------------------------
    // 3. Fetch property total_sqft
    // ---------------------------------------------------------------
    const { data: property, error: propErr } = await supabaseAdmin
      .from("properties")
      .select("id, total_sqft")
      .eq("id", property_id)
      .single();

    if (propErr) throw new Error(`Failed to fetch property: ${propErr.message}`);

    const totalSqft = property.total_sqft || 0;

    // ---------------------------------------------------------------
    // 4. Classify expenses by classification
    // ---------------------------------------------------------------
    const byClassification = {
      recoverable: 0,
      non_recoverable: 0,
      conditional: 0,
    };

    for (const exp of expenses) {
      const cls = exp.classification || "non_recoverable";
      if (cls in byClassification) {
        byClassification[cls] += Number(exp.amount) || 0;
      } else {
        byClassification.non_recoverable += Number(exp.amount) || 0;
      }
    }

    const totalExpenses =
      byClassification.recoverable +
      byClassification.non_recoverable +
      byClassification.conditional;

    const totalRecoverable = byClassification.recoverable;

    // ---------------------------------------------------------------
    // 5. Fetch lease_config for every active lease
    // ---------------------------------------------------------------
    const leaseIds = leases.map((l: any) => l.id);
    let leaseConfigs: Record<string, any> = {};

    if (leaseIds.length > 0) {
      const { data: configs, error: cfgErr } = await supabaseAdmin
        .from("lease_config")
        .select("*")
        .in("lease_id", leaseIds);

      if (cfgErr) {
        console.error("[compute-expense] lease_config fetch error:", cfgErr.message);
      }

      if (configs) {
        for (const cfg of configs) {
          leaseConfigs[cfg.lease_id] = cfg;
        }
      }
    }

    // ---------------------------------------------------------------
    // 6. Build a lookup of recoverable expenses by category
    //    (needed for base_year and excluded_expenses logic)
    // ---------------------------------------------------------------
    const recoverableByCategory: Record<string, number> = {};
    for (const exp of expenses) {
      if (exp.classification === "recoverable") {
        const cat = exp.category || "uncategorized";
        recoverableByCategory[cat] =
          (recoverableByCategory[cat] || 0) + (Number(exp.amount) || 0);
      }
    }

    // ---------------------------------------------------------------
    // 7. Allocate recoverable expenses across tenants
    // ---------------------------------------------------------------
    const tenantAllocations: any[] = [];

    for (const lease of leases) {
      const sqft = Number(lease.square_footage) || 0;
      const proRataShare = totalSqft > 0 ? sqft / totalSqft : 0;
      const cfg = leaseConfigs[lease.id] || {};

      // Start with tenant-specific recoverable total, honouring exclusions
      const excludedCategories: string[] = cfg.excluded_expenses || [];
      let tenantRecoverable = 0;

      if (excludedCategories.length > 0) {
        // Sum only non-excluded categories
        for (const [cat, amt] of Object.entries(recoverableByCategory)) {
          if (!excludedCategories.includes(cat)) {
            tenantRecoverable += amt as number;
          }
        }
      } else {
        tenantRecoverable = totalRecoverable;
      }

      let allocatedAmount = tenantRecoverable * proRataShare;

      // Base year adjustment: tenant only pays excess over base_year amount
      let afterBaseYear = allocatedAmount;
      if (cfg.base_year && cfg.base_year < fiscal_year) {
        // Fetch the base year expenses for the same property to determine the
        // base year amount.  We query only the recoverable expenses for the
        // base year and compute the same pro-rata share.
        const { data: baseExpenses, error: baseErr } = await supabaseAdmin
          .from("expenses")
          .select("amount, classification, category")
          .eq("org_id", orgId)
          .eq("property_id", property_id)
          .eq("fiscal_year", cfg.base_year)
          .eq("classification", "recoverable");

        if (!baseErr && baseExpenses) {
          let baseRecoverable = 0;
          for (const be of baseExpenses) {
            const cat = be.category || "uncategorized";
            if (excludedCategories.length === 0 || !excludedCategories.includes(cat)) {
              baseRecoverable += Number(be.amount) || 0;
            }
          }
          const baseAmount = baseRecoverable * proRataShare;
          afterBaseYear = Math.max(0, allocatedAmount - baseAmount);
        }
      }

      // CAM cap: cap the allocated amount
      let afterCap = afterBaseYear;
      if (cfg.cam_cap !== undefined && cfg.cam_cap !== null) {
        afterCap = Math.min(afterBaseYear, Number(cfg.cam_cap));
      }

      tenantAllocations.push({
        tenant_name: lease.tenant_name,
        lease_id: lease.id,
        pro_rata_share: Math.round(proRataShare * 10000) / 10000, // 4 decimals
        allocated_amount: Math.round(allocatedAmount * 100) / 100,
        after_base_year: Math.round(afterBaseYear * 100) / 100,
        after_cap: Math.round(afterCap * 100) / 100,
      });
    }

    // ---------------------------------------------------------------
    // 8. Monthly breakdown
    // ---------------------------------------------------------------
    const monthlyMap: Record<
      number,
      { total: number; recoverable: number; non_recoverable: number; conditional: number }
    > = {};

    for (const exp of expenses) {
      const m = exp.month ?? new Date(exp.date).getMonth() + 1;
      if (!monthlyMap[m]) {
        monthlyMap[m] = { total: 0, recoverable: 0, non_recoverable: 0, conditional: 0 };
      }
      const amt = Number(exp.amount) || 0;
      monthlyMap[m].total += amt;
      const cls = exp.classification || "non_recoverable";
      if (cls === "recoverable") {
        monthlyMap[m].recoverable += amt;
      } else if (cls === "conditional") {
        monthlyMap[m].conditional += amt;
      } else {
        monthlyMap[m].non_recoverable += amt;
      }
    }

    const monthlyBreakdown = Object.keys(monthlyMap)
      .map(Number)
      .sort((a, b) => a - b)
      .map((month) => ({
        month,
        total: Math.round(monthlyMap[month].total * 100) / 100,
        recoverable: Math.round(monthlyMap[month].recoverable * 100) / 100,
        non_recoverable: Math.round(monthlyMap[month].non_recoverable * 100) / 100,
      }));

    // ---------------------------------------------------------------
    // 9. Store computation snapshot
    // ---------------------------------------------------------------
    const sortedExpenses = [...(expenses ?? [])].sort((left: any, right: any) =>
      String(left?.id ?? "").localeCompare(String(right?.id ?? "")),
    );
    const sortedLeases = [...(leases ?? [])].sort((left: any, right: any) =>
      String(left?.id ?? "").localeCompare(String(right?.id ?? "")),
    );

    const inputs = {
      property_id,
      fiscal_year,
      expense_count: sortedExpenses.length,
      lease_count: sortedLeases.length,
      _compute: {
        page_scope: ["Expenses", "AddExpense", "BulkImport"],
        source_tables: ["expenses", "leases", "lease_config", "properties"],
        source_row_ids: {
          expenses: sortedExpenses.map((expense: any) => expense.id),
          leases: sortedLeases.map((lease: any) => lease.id),
        },
        source_counts: {
          expenses: sortedExpenses.length,
          leases: sortedLeases.length,
        },
        trigger_type: req.headers.get("x-compute-trigger") ?? "manual",
        source_file_id: req.headers.get("x-source-file-id") ?? null,
      },
    };

    const outputs = {
      total_expenses: Math.round(totalExpenses * 100) / 100,
      by_classification: {
        recoverable: Math.round(byClassification.recoverable * 100) / 100,
        non_recoverable: Math.round(byClassification.non_recoverable * 100) / 100,
        conditional: Math.round(byClassification.conditional * 100) / 100,
      },
      tenant_allocations: tenantAllocations,
      monthly_breakdown: monthlyBreakdown,
    };

    const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id,
      engine_type: "expense",
      fiscal_year,
      inputs,
      outputs,
      computed_by: user.email ?? user.id,
    });

    if (existingSnapshot?.outputs) {
      return new Response(
        JSON.stringify({
          error: false,
          property_id,
          fiscal_year,
          ...existingSnapshot.outputs,
          snapshot_id: existingSnapshot.id,
          reused_snapshot: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id,
      engine_type: "expense",
      fiscal_year,
      computed_by: user.email ?? user.id,
      inputs,
      outputs,
    });

    // ---------------------------------------------------------------
    // 10. Respond
    // ---------------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        property_id,
        fiscal_year,
        total_expenses: outputs.total_expenses,
        by_classification: outputs.by_classification,
        tenant_allocations: tenantAllocations,
        monthly_breakdown: monthlyBreakdown,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[compute-expense] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
