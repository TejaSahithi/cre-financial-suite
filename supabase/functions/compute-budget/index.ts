// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { saveSnapshot } from "../_shared/snapshot.ts";

/**
 * Compute Budget Edge Function
 * Generates budgets aggregating revenue projections and expense plans.
 * Supports approval workflow and versioning.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 * Task: 12.1
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json();
    const { property_id, fiscal_year, action } = body;

    if (!property_id || !fiscal_year) {
      throw new Error("property_id and fiscal_year are required");
    }

    const resolvedAction = action || "generate";

    // ---------------------------------------------------------------
    // Route to the appropriate action handler
    // ---------------------------------------------------------------
    switch (resolvedAction) {
      case "generate":
        return await handleGenerate(supabaseAdmin, orgId, user.id, property_id, fiscal_year);
      case "approve":
        return await handleStatusTransition(supabaseAdmin, orgId, user.id, property_id, fiscal_year, "under_review", "approved", "Budget approved successfully");
      case "reject":
        return await handleStatusTransition(supabaseAdmin, orgId, user.id, property_id, fiscal_year, "under_review", "draft", "Budget rejected and returned to draft");
      case "lock":
        return await handleLock(supabaseAdmin, orgId, user.id, property_id, fiscal_year);
      default:
        throw new Error(`Unknown action: ${resolvedAction}. Must be one of: generate, approve, reject, lock`);
    }
  } catch (err) {
    console.error("[compute-budget] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =================================================================
// Action: generate
// =================================================================
async function handleGenerate(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  propertyId: string,
  fiscalYear: number
) {
  // ---------------------------------------------------------------
  // 1. Fetch property details
  // ---------------------------------------------------------------
  const { data: property, error: propErr } = await supabaseAdmin
    .from("properties")
    .select("id, name")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .single();

  if (propErr || !property) {
    throw new Error(`Property not found: ${propErr?.message ?? propertyId}`);
  }

  // ---------------------------------------------------------------
  // 2. Calculate total projected revenue
  // ---------------------------------------------------------------

  // 2a. Base rent from active leases
  const { data: leases, error: leaseErr } = await supabaseAdmin
    .from("leases")
    .select("id, monthly_rent, start_date, end_date, status")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("status", "active");

  if (leaseErr) {
    throw new Error(`Failed to fetch leases: ${leaseErr.message}`);
  }

  let baseRent = 0;
  const fyStart = new Date(fiscalYear, 0, 1); // Jan 1 of fiscal year
  const fyEnd = new Date(fiscalYear, 11, 31); // Dec 31 of fiscal year

  for (const lease of leases ?? []) {
    const monthlyRent = Number(lease.monthly_rent) || 0;
    const leaseStart = new Date(lease.start_date);
    const leaseEnd = lease.end_date ? new Date(lease.end_date) : fyEnd;

    // Determine overlap with fiscal year
    const overlapStart = leaseStart > fyStart ? leaseStart : fyStart;
    const overlapEnd = leaseEnd < fyEnd ? leaseEnd : fyEnd;

    if (overlapStart <= overlapEnd) {
      // Calculate months of overlap
      const startMonth = overlapStart.getFullYear() * 12 + overlapStart.getMonth();
      const endMonth = overlapEnd.getFullYear() * 12 + overlapEnd.getMonth();
      const activeMonths = endMonth - startMonth + 1;
      baseRent += monthlyRent * activeMonths;
    }
  }

  // 2b. CAM recovery from latest cam computation snapshot
  let camRecovery = 0;
  const { data: camSnapshot, error: camSnapErr } = await supabaseAdmin
    .from("computation_snapshots")
    .select("outputs")
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!camSnapErr && camSnapshot && camSnapshot.length > 0) {
    const camOutputs = camSnapshot[0].outputs;
    camRecovery = Number(camOutputs?.total_cam) || 0;
  }

  // 2c. Other revenue from revenues table
  let otherIncome = 0;
  const { data: revenues, error: revErr } = await supabaseAdmin
    .from("revenues")
    .select("type, amount, month")
    .eq("property_id", propertyId)
    .eq("fiscal_year", fiscalYear);

  if (!revErr && revenues) {
    for (const rev of revenues) {
      otherIncome += Number(rev.amount) || 0;
    }
  }

  const totalRevenue = baseRent + camRecovery + otherIncome;

  // ---------------------------------------------------------------
  // 3. Calculate total projected expenses
  // ---------------------------------------------------------------
  const { data: expenses, error: expErr } = await supabaseAdmin
    .from("expenses")
    .select("id, category, amount, classification, month")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("fiscal_year", fiscalYear);

  if (expErr) {
    throw new Error(`Failed to fetch expenses: ${expErr.message}`);
  }

  // Group expenses by category
  const expenseByCategory: Record<string, number> = {};
  let totalExpenses = 0;

  for (const exp of expenses ?? []) {
    const amount = Number(exp.amount) || 0;
    const category = (exp.category || "other").toLowerCase();
    expenseByCategory[category] = (expenseByCategory[category] || 0) + amount;
    totalExpenses += amount;
  }

  // ---------------------------------------------------------------
  // 4. Generate budget line items
  // ---------------------------------------------------------------

  // Revenue lines
  const revenueLines: Record<string, number> = {
    base_rent: round2(baseRent),
    cam_recovery: round2(camRecovery),
    other_income: round2(otherIncome),
    total: round2(totalRevenue),
  };

  // Expense lines - extract known categories, rest goes to "other"
  const knownCategories = ["utilities", "maintenance", "insurance", "taxes", "management"];
  const expenseLines: Record<string, number> = {};

  for (const cat of knownCategories) {
    expenseLines[cat] = round2(expenseByCategory[cat] || 0);
  }

  // Aggregate remaining categories into "other"
  let otherExpenses = 0;
  for (const [cat, amt] of Object.entries(expenseByCategory)) {
    if (!knownCategories.includes(cat)) {
      otherExpenses += amt;
    }
  }
  expenseLines.other = round2(otherExpenses);
  expenseLines.total = round2(totalExpenses);

  // NOI
  const noi = round2(totalRevenue - totalExpenses);

  const lineItems = {
    revenue: revenueLines,
    expenses: expenseLines,
    noi,
  };

  // ---------------------------------------------------------------
  // 5. Create or update budget record with status='draft'
  // ---------------------------------------------------------------
  const budgetName = `${property.name} - FY ${fiscalYear} Budget`;

  const budgetPayload = {
    org_id: orgId,
    property_id: propertyId,
    name: budgetName,
    budget_year: fiscalYear,
    total_revenue: round2(totalRevenue),
    total_expenses: round2(totalExpenses),
    noi: noi,
    cam_total: round2(camRecovery),
    generation_method: "automated",
    period: "annual",
    scope: "property",
    status: "draft",
    updated_at: new Date().toISOString(),
  };

  // Try to find an existing budget for this property and year
  const { data: existingBudget } = await supabaseAdmin
    .from("budgets")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("budget_year", fiscalYear)
    .limit(1);

  if (existingBudget && existingBudget.length > 0) {
    const existing = existingBudget[0];
    if (existing.status === "locked") {
      throw new Error("Cannot regenerate a locked budget. Create a new version instead.");
    }
    if (existing.status === "approved") {
      throw new Error("Cannot regenerate an approved budget. Reject it first or lock and create a new version.");
    }
  }

  const { data: upsertData, error: upsertErr } = await supabaseAdmin
    .from("budgets")
    .upsert({
      ...budgetPayload,
      created_at: new Date().toISOString(), // Will be ignored on update if we don't include it in onConflict, but we want it for new rows
    }, { 
      onConflict: "org_id,property_id,budget_year" 
    })
    .select("id")
    .single();

  if (upsertErr) {
    throw new Error(`Failed to save budget: ${upsertErr.message}`);
  }
  const budgetId = upsertData.id;


  // ---------------------------------------------------------------
  // 6. Store in computation_snapshots with engine_type='budget'
  // ---------------------------------------------------------------
  const snapshotPayload = {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      lease_count: (leases ?? []).length,
      expense_count: (expenses ?? []).length,
      revenue_count: (revenues ?? []).length,
    },
    outputs: {
      budget_id: budgetId,
      status: "draft",
      line_items: lineItems,
    },
  };

  await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    inputs: snapshotPayload.inputs,
    outputs: snapshotPayload.outputs,
  });

  // ---------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------
  return new Response(
    JSON.stringify({
      error: false,
      property_id: propertyId,
      fiscal_year: fiscalYear,
      budget_id: budgetId,
      status: "draft",
      line_items: lineItems,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: approve / reject (shared status transition handler)
// =================================================================
async function handleStatusTransition(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  propertyId: string,
  fiscalYear: number,
  requiredStatus: string,
  newStatus: string,
  successMessage: string
) {
  // Fetch budget
  const { data: budgets, error: fetchErr } = await supabaseAdmin
    .from("budgets")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("budget_year", fiscalYear)
    .limit(1);

  if (fetchErr) {
    throw new Error(`Failed to fetch budget: ${fetchErr.message}`);
  }

  if (!budgets || budgets.length === 0) {
    throw new Error(`No budget found for property ${propertyId} and fiscal year ${fiscalYear}`);
  }

  const budget = budgets[0];

  if (budget.status !== requiredStatus) {
    throw new Error(
      `Budget status must be '${requiredStatus}' to perform this action. Current status: '${budget.status}'`
    );
  }

  // Update status
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to update budget status: ${updateErr.message}`);
  }

  // Create audit log entry
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, newStatus, successMessage);

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      status: newStatus,
      message: successMessage,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: lock
// =================================================================
async function handleLock(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  propertyId: string,
  fiscalYear: number
) {
  // Fetch budget
  const { data: budgets, error: fetchErr } = await supabaseAdmin
    .from("budgets")
    .select("id, status, total_revenue, total_expenses")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("budget_year", fiscalYear)
    .limit(1);

  if (fetchErr) {
    throw new Error(`Failed to fetch budget: ${fetchErr.message}`);
  }

  if (!budgets || budgets.length === 0) {
    throw new Error(`No budget found for property ${propertyId} and fiscal year ${fiscalYear}`);
  }

  const budget = budgets[0];

  if (budget.status !== "approved") {
    throw new Error(
      `Budget must be 'approved' to lock. Current status: '${budget.status}'`
    );
  }

  // Update status to locked
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "locked",
      updated_at: new Date().toISOString(),
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to lock budget: ${updateErr.message}`);
  }

  // Create baseline snapshot for variance analysis
  const { data: latestSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("outputs")
    .eq("property_id", propertyId)
    .eq("engine_type", "budget")
    .eq("fiscal_year", fiscalYear)
    .order("created_at", { ascending: false })
    .limit(1);

  const baselineOutputs = latestSnapshot && latestSnapshot.length > 0
    ? latestSnapshot[0].outputs
    : {
        budget_id: budget.id,
        total_revenue: Number(budget.total_revenue),
        total_expenses: Number(budget.total_expenses),
      };

  const baselinePayload = {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      action: "lock",
      locked_at: new Date().toISOString(),
      locked_by: userId,
    },
    outputs: {
      ...baselineOutputs,
      baseline: true,
      status: "locked",
      locked_at: new Date().toISOString(),
    },
  };

  const { error: snapErr } = await supabaseAdmin
    .from("computation_snapshots")
    .insert(baselinePayload);

  if (snapErr) {
    console.error("[compute-budget] baseline snapshot insert error:", snapErr.message);
  }

  // Create audit log entry
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, "locked", "Budget locked successfully");

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      status: "locked",
      message: "Budget locked successfully",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Helpers
// =================================================================

/**
 * Round a number to two decimal places.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Create an audit log entry for budget status changes.
 */
async function createAuditLog(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  budgetId: string,
  propertyId: string,
  fiscalYear: number,
  newStatus: string,
  message: string
) {
  const auditPayload = {
    org_id: orgId,
    user_id: userId,
    entity_type: "budget",
    entity_id: budgetId,
    action: `budget_${newStatus}`,
    details: {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      new_status: newStatus,
      message,
      timestamp: new Date().toISOString(),
    },
  };

  const { error: auditErr } = await supabaseAdmin
    .from("audit_logs")
    .insert(auditPayload);

  if (auditErr) {
    console.error("[compute-budget] audit_log insert error:", auditErr.message);
  }
}
