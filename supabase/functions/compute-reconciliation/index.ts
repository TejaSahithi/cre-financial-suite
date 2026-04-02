// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Compute Reconciliation Edge Function
 * Performs variance analysis between budget and actuals.
 * Flags high-variance items (>10%).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 * Task: 13.1
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
      throw new Error("Missing required fields: property_id and fiscal_year");
    }

    // ---------------------------------------------------------------
    // 1. Fetch budget for property_id and fiscal_year
    // ---------------------------------------------------------------
    const { data: budget, error: budgetErr } = await supabaseAdmin
      .from("budgets")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("budget_year", fiscal_year)
      .in("status", ["approved", "locked", "draft", "pending_approval"])
      .order("status", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (budgetErr) throw new Error(`Failed to fetch budget: ${budgetErr.message}`);
    if (!budget) throw new Error(`No budget found for property ${property_id} and fiscal year ${fiscal_year}`);

    // ---------------------------------------------------------------
    // 2. Fetch all actuals for property_id and fiscal_year
    // ---------------------------------------------------------------
    const { data: actuals, error: actualsErr } = await supabaseAdmin
      .from("actuals")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year);

    if (actualsErr) throw new Error(`Failed to fetch actuals: ${actualsErr.message}`);

    // ---------------------------------------------------------------
    // 3. Fetch all expenses for property_id and fiscal_year
    // ---------------------------------------------------------------
    const { data: expenses, error: expErr } = await supabaseAdmin
      .from("expenses")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year);

    if (expErr) throw new Error(`Failed to fetch expenses: ${expErr.message}`);

    // ---------------------------------------------------------------
    // 4. Fetch all revenues for property_id and fiscal_year
    // ---------------------------------------------------------------
    const { data: revenues, error: revErr } = await supabaseAdmin
      .from("revenues")
      .select("*")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year);

    if (revErr) throw new Error(`Failed to fetch revenues: ${revErr.message}`);

    // ---------------------------------------------------------------
    // 5. Fetch budget line items from computation_snapshots
    //    (engine_type='budget') for category-level budget breakdown
    // ---------------------------------------------------------------
    const { data: budgetSnapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("inputs, outputs")
      .eq("property_id", property_id)
      .eq("fiscal_year", fiscal_year)
      .eq("engine_type", "budget")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Build budget-by-category lookup from snapshot or fall back to even split
    const budgetByCategory: Record<string, number> = {};
    if (budgetSnapshot?.outputs?.line_items) {
      for (const item of budgetSnapshot.outputs.line_items) {
        const cat = item.category || "uncategorized";
        budgetByCategory[cat] = (budgetByCategory[cat] || 0) + (Number(item.amount) || 0);
      }
    } else if (budgetSnapshot?.outputs?.by_category) {
      for (const [cat, amt] of Object.entries(budgetSnapshot.outputs.by_category)) {
        budgetByCategory[cat] = Number(amt) || 0;
      }
    }

    // ---------------------------------------------------------------
    // 6. Calculate variance by category
    // ---------------------------------------------------------------

    // Group actuals by category
    const actualsByCategory: Record<string, number> = {};
    for (const a of (actuals ?? [])) {
      const cat = a.category || "uncategorized";
      actualsByCategory[cat] = (actualsByCategory[cat] || 0) + (Number(a.amount) || 0);
    }

    // Also fold expenses into category totals (expenses = actual expenses)
    for (const e of (expenses ?? [])) {
      const cat = e.category || "uncategorized";
      actualsByCategory[cat] = (actualsByCategory[cat] || 0) + (Number(e.amount) || 0);
    }

    // Collect all categories from both budget and actuals
    const allCategories = new Set<string>([
      ...Object.keys(budgetByCategory),
      ...Object.keys(actualsByCategory),
    ]);

    const lineItems: any[] = [];
    const flaggedItems: any[] = [];

    for (const category of allCategories) {
      const budgetAmount = Math.round((budgetByCategory[category] || 0) * 100) / 100;
      const actualAmount = Math.round((actualsByCategory[category] || 0) * 100) / 100;
      const variance = Math.round((actualAmount - budgetAmount) * 100) / 100;
      const variancePct =
        budgetAmount !== 0
          ? Math.round(((variance / budgetAmount) * 100) * 100) / 100
          : 0;
      const flagged = Math.abs(variancePct) > 10;

      const item = {
        category,
        budget: budgetAmount,
        actual: actualAmount,
        variance,
        variance_pct: variancePct,
        flagged,
      };

      lineItems.push(item);
      if (flagged) {
        flaggedItems.push(item);
      }
    }

    // ---------------------------------------------------------------
    // 7. Calculate overall variance
    // ---------------------------------------------------------------

    // Total actual revenue from revenues table
    const totalActualRevenue = (revenues ?? []).reduce(
      (sum: number, r: any) => sum + (Number(r.amount) || 0),
      0
    );

    // Total actual expenses from expenses table
    const totalActualExpenses = (expenses ?? []).reduce(
      (sum: number, e: any) => sum + (Number(e.amount) || 0),
      0
    );

    const budgetRevenue = Number(budget.total_revenue) || 0;
    const budgetExpenses = Number(budget.total_expenses) || 0;

    const revenueVariance = Math.round((totalActualRevenue - budgetRevenue) * 100) / 100;
    const revenueVariancePct =
      budgetRevenue !== 0
        ? Math.round(((revenueVariance / budgetRevenue) * 100) * 100) / 100
        : 0;

    const expenseVariance = Math.round((totalActualExpenses - budgetExpenses) * 100) / 100;
    const expenseVariancePct =
      budgetExpenses !== 0
        ? Math.round(((expenseVariance / budgetExpenses) * 100) * 100) / 100
        : 0;

    const budgetNoi = Math.round((budgetRevenue - budgetExpenses) * 100) / 100;
    const actualNoi = Math.round((totalActualRevenue - totalActualExpenses) * 100) / 100;
    const noiVariance = Math.round((actualNoi - budgetNoi) * 100) / 100;

    const summary = {
      budget_revenue: Math.round(budgetRevenue * 100) / 100,
      actual_revenue: Math.round(totalActualRevenue * 100) / 100,
      revenue_variance: revenueVariance,
      revenue_variance_pct: revenueVariancePct,
      budget_expenses: Math.round(budgetExpenses * 100) / 100,
      actual_expenses: Math.round(totalActualExpenses * 100) / 100,
      expense_variance: expenseVariance,
      expense_variance_pct: expenseVariancePct,
      budget_noi: budgetNoi,
      actual_noi: actualNoi,
      noi_variance: noiVariance,
    };

    // ---------------------------------------------------------------
    // 8. Monthly drill-down: compare actual vs budget by category
    // ---------------------------------------------------------------
    const monthlyDrillDown: Record<number, Record<string, { budget: number; actual: number; variance: number }>> = {};

    // Group actuals by month and category
    for (const a of (actuals ?? [])) {
      const month = Number(a.month) || 0;
      if (month < 1 || month > 12) continue;
      const cat = a.category || "uncategorized";
      if (!monthlyDrillDown[month]) monthlyDrillDown[month] = {};
      if (!monthlyDrillDown[month][cat]) monthlyDrillDown[month][cat] = { budget: 0, actual: 0, variance: 0 };
      monthlyDrillDown[month][cat].actual += Number(a.amount) || 0;
    }

    // Also fold expenses into monthly drill-down
    for (const e of (expenses ?? [])) {
      const month = Number(e.month) || 0;
      if (month < 1 || month > 12) continue;
      const cat = e.category || "uncategorized";
      if (!monthlyDrillDown[month]) monthlyDrillDown[month] = {};
      if (!monthlyDrillDown[month][cat]) monthlyDrillDown[month][cat] = { budget: 0, actual: 0, variance: 0 };
      monthlyDrillDown[month][cat].actual += Number(e.amount) || 0;
    }

    // Distribute budget evenly across 12 months per category (if no monthly budget data)
    for (const category of allCategories) {
      const monthlyBudget = Math.round(((budgetByCategory[category] || 0) / 12) * 100) / 100;
      for (let m = 1; m <= 12; m++) {
        if (!monthlyDrillDown[m]) monthlyDrillDown[m] = {};
        if (!monthlyDrillDown[m][category]) monthlyDrillDown[m][category] = { budget: 0, actual: 0, variance: 0 };
        monthlyDrillDown[m][category].budget += monthlyBudget;
      }
    }

    // Calculate variance for each month/category
    for (const month of Object.keys(monthlyDrillDown).map(Number)) {
      for (const cat of Object.keys(monthlyDrillDown[month])) {
        const entry = monthlyDrillDown[month][cat];
        entry.budget = Math.round(entry.budget * 100) / 100;
        entry.actual = Math.round(entry.actual * 100) / 100;
        entry.variance = Math.round((entry.actual - entry.budget) * 100) / 100;
      }
    }

    // Format monthly drill-down as sorted array
    const monthlyBreakdown = Object.keys(monthlyDrillDown)
      .map(Number)
      .sort((a, b) => a - b)
      .map((month) => ({
        month,
        categories: Object.entries(monthlyDrillDown[month]).map(([category, data]) => ({
          category,
          budget: data.budget,
          actual: data.actual,
          variance: data.variance,
        })),
      }));

    // ---------------------------------------------------------------
    // 9. Insert/update variance records in variances table
    // ---------------------------------------------------------------
    const varianceRecords = lineItems.map((item) => ({
      org_id: orgId,
      property_id,
      fiscal_year,
      month: null,
      category: item.category,
      budget_amount: item.budget,
      actual_amount: item.actual,
      variance_amount: item.variance,
      variance_pct: item.variance_pct,
    }));

    // Also insert monthly variance records
    for (const monthEntry of monthlyBreakdown) {
      for (const catEntry of monthEntry.categories) {
        const budgetAmt = catEntry.budget;
        const actualAmt = catEntry.actual;
        const varianceAmt = catEntry.variance;
        const variancePct =
          budgetAmt !== 0
            ? Math.round(((varianceAmt / budgetAmt) * 100) * 100) / 100
            : 0;

        varianceRecords.push({
          org_id: orgId,
          property_id,
          fiscal_year,
          month: monthEntry.month,
          category: catEntry.category,
          budget_amount: budgetAmt,
          actual_amount: actualAmt,
          variance_amount: varianceAmt,
          variance_pct: variancePct,
        });
      }
    }

    if (varianceRecords.length > 0) {
      // Delete existing variance records for this property/fiscal_year first
      const { error: delErr } = await supabaseAdmin
        .from("variances")
        .delete()
        .eq("org_id", orgId)
        .eq("property_id", property_id)
        .eq("fiscal_year", fiscal_year);

      if (delErr) {
        console.error("[compute-reconciliation] Variance delete error:", delErr.message);
      }

      const { error: varInsertErr } = await supabaseAdmin
        .from("variances")
        .insert(varianceRecords);

      if (varInsertErr) {
        console.error("[compute-reconciliation] Variance insert error:", varInsertErr.message);
      }
    }

    // ---------------------------------------------------------------
    // 10. Create/update reconciliations record
    // ---------------------------------------------------------------
    const totalRecoverable = Number(budget.total_revenue) || 0;
    const totalBilled = (actuals ?? []).reduce(
      (sum: number, a: any) => sum + (Number(a.amount) || 0),
      0
    );
    const reconciliationVariance = Math.round((totalRecoverable - totalBilled) * 100) / 100;

    const reconciliationPayload = {
      org_id: orgId,
      property_id,
      fiscal_year,
      status: "completed",
      total_recoverable: Math.round(totalRecoverable * 100) / 100,
      total_billed: Math.round(totalBilled * 100) / 100,
      variance: reconciliationVariance,
      completed_at: new Date().toISOString(),
    };

    // Try upsert first; fall back to insert
    const { data: reconData, error: reconErr } = await supabaseAdmin
      .from("reconciliations")
      .upsert(reconciliationPayload, {
        onConflict: "org_id,property_id,fiscal_year",
      })
      .select("id")
      .maybeSingle();

    let reconciliationId = reconData?.id ?? null;

    if (reconErr) {
      console.error("[compute-reconciliation] Reconciliation upsert error:", reconErr.message);
      // Fall back to insert
      const { data: insertData, error: insertErr } = await supabaseAdmin
        .from("reconciliations")
        .insert(reconciliationPayload)
        .select("id")
        .maybeSingle();

      if (insertErr) {
        console.error("[compute-reconciliation] Reconciliation insert error:", insertErr.message);
      }
      reconciliationId = insertData?.id ?? null;
    }

    // ---------------------------------------------------------------
    // 11. Store in computation_snapshots with engine_type='reconciliation'
    // ---------------------------------------------------------------
    const snapshotPayload = {
      org_id: orgId,
      property_id,
      engine_type: "reconciliation",
      fiscal_year,
      inputs: {
        property_id,
        fiscal_year,
        budget_id: budget.id,
        actuals_count: (actuals ?? []).length,
        expenses_count: (expenses ?? []).length,
        revenues_count: (revenues ?? []).length,
      },
      outputs: {
        summary,
        line_items: lineItems,
        flagged_items: flaggedItems,
        monthly_breakdown: monthlyBreakdown,
        reconciliation_id: reconciliationId,
      },
    };

    const { error: snapErr } = await supabaseAdmin
      .from("computation_snapshots")
      .insert(snapshotPayload);

    if (snapErr) {
      console.error("[compute-reconciliation] Snapshot insert error:", snapErr.message);
    }

    // ---------------------------------------------------------------
    // 12. Respond
    // ---------------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        property_id,
        fiscal_year,
        reconciliation_id: reconciliationId,
        status: "completed",
        summary,
        line_items: lineItems,
        flagged_items: flaggedItems,
        monthly_breakdown: monthlyBreakdown,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[compute-reconciliation] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
