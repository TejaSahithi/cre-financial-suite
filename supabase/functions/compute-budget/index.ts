// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";

const ENGINE_VERSION = "budget-v1.0";

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
    const { property_id, fiscal_year, action, allow_generate_without_cam, readiness_snapshot, ai_insights, reason } = body;

    if (!property_id || !fiscal_year) {
      throw new Error("property_id and fiscal_year are required");
    }

    await assertPageAccess(req, orgId, ["BudgetDashboard", "CreateBudget"], "write");
    await assertPropertyAccess(req, property_id);

    const resolvedAction = action || "generate";

    // ---------------------------------------------------------------
    // Route to the appropriate action handler
    // ---------------------------------------------------------------
    switch (resolvedAction) {
      case "generate":
        return await handleGenerate(supabaseAdmin, orgId, user.id, property_id, fiscal_year, allow_generate_without_cam === true, readiness_snapshot ?? null, typeof ai_insights === "string" ? ai_insights : null);
      case "approve":
        // CreateBudget.jsx's UI only ever offers "Approve" once a budget has
        // been marked "reviewed" (a CreateBudget-specific intermediate step
        // compute-budget itself has no concept of) — accept either status so
        // the one enforced approval gate matches how the UI actually drives
        // it, instead of a precondition the UI could never satisfy.
        return await handleStatusTransition(supabaseAdmin, orgId, user.id, property_id, fiscal_year, ["under_review", "reviewed"], "approved", "Budget approved successfully");
      case "mark_reviewed":
        // Matches CreateBudget.jsx's "Mark as Reviewed" button, which is
        // offered from draft/ai_generated/under_review.
        return await handleMarkReviewed(supabaseAdmin, orgId, user.id, property_id, fiscal_year);
      case "reject":
        // CreateBudget.jsx's "Reject / Rework" button is offered from any
        // status except approved/locked/signed (not just 'under_review') and
        // carries a required rejection comment.
        return await handleReject(supabaseAdmin, orgId, user.id, property_id, fiscal_year, typeof reason === "string" ? reason : null);
      case "lock":
        return await handleLock(supabaseAdmin, orgId, user.id, property_id, fiscal_year);
      default:
        throw new Error(`Unknown action: ${resolvedAction}. Must be one of: generate, approve, mark_reviewed, reject, lock`);
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
  fiscalYear: number,
  allowGenerateWithoutCam = false,
  readinessSnapshot: any = null,
  aiInsights: string | null = null
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

  const { data: revenueSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "revenue")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: expenseSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "expense")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!revenueSnapshot?.outputs) {
    throw new Error("Revenue snapshot is required before generating a budget");
  }
  if (!expenseSnapshot?.outputs) {
    throw new Error("Expense snapshot is required before generating a budget");
  }

  // ---------------------------------------------------------------
  // 2. Calculate total projected revenue from trusted snapshots + stored detail
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

  let baseRent = Number(revenueSnapshot?.outputs?.summary?.revenue_by_type?.base_rent ?? 0);
  const fyStart = new Date(fiscalYear, 0, 1); // Jan 1 of fiscal year
  const fyEnd = new Date(fiscalYear, 11, 31); // Dec 31 of fiscal year

  if (baseRent === 0) {
    for (const lease of leases ?? []) {
      const monthlyRent = Number(lease.monthly_rent) || 0;
      const leaseStart = new Date(lease.start_date);
      const leaseEnd = lease.end_date ? new Date(lease.end_date) : fyEnd;

      const overlapStart = leaseStart > fyStart ? leaseStart : fyStart;
      const overlapEnd = leaseEnd < fyEnd ? leaseEnd : fyEnd;

      if (overlapStart <= overlapEnd) {
        const startMonth = overlapStart.getFullYear() * 12 + overlapStart.getMonth();
        const endMonth = overlapEnd.getFullYear() * 12 + overlapEnd.getMonth();
        const activeMonths = endMonth - startMonth + 1;
        baseRent += monthlyRent * activeMonths;
      }
    }
  }

  // 2b. CAM recovery from latest cam computation snapshot
  let camRecovery = 0;
  const { data: camSnapshot, error: camSnapErr } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1);

  if (!camSnapErr && camSnapshot && camSnapshot.length > 0) {
    const camOutputs = camSnapshot[0].outputs;
    camRecovery = Number(camOutputs?.total_cam) || 0;
  } else if (!allowGenerateWithoutCam) {
    throw new Error("CAM snapshot is required before generating a budget. Re-run with allow_generate_without_cam=true only when you intentionally want to bypass CAM.");
  }

  // 2c. Other revenue from revenues table
  let otherIncome = Number(revenueSnapshot?.outputs?.summary?.revenue_by_type?.other_income ?? 0);
  const { data: revenues, error: revErr } = await supabaseAdmin
    .from("revenues")
    .select("type, amount, month")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("fiscal_year", fiscalYear);

  if (!revErr && revenues && otherIncome === 0) {
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
  let totalExpenses = Number(expenseSnapshot?.outputs?.total_expenses ?? 0);

  for (const exp of expenses ?? []) {
    const amount = Number(exp.amount) || 0;
    const category = (exp.category || "other").toLowerCase();
    expenseByCategory[category] = (expenseByCategory[category] || 0) + amount;
    if (!expenseSnapshot?.outputs?.total_expenses) {
      totalExpenses += amount;
    }
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
    // Only set ai_insights when the caller actually provided a fresh value
    // (e.g. CreateBudget.jsx's OpenAI preview text) — omitting the key
    // entirely on a bare re-generate call preserves whatever was stored
    // previously instead of clobbering it with null.
    ...(aiInsights ? { ai_insights: aiInsights } : {}),
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
      readiness_snapshot: readinessSnapshot,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "leases", "expenses", "revenues", "computation_snapshots"],
        source_row_ids: {
          leases: (leases ?? []).map((lease: any) => lease.id).sort(),
          expenses: (expenses ?? []).map((expense: any) => expense.id).sort(),
          revenues: (revenues ?? []).map((revenue: any) => revenue.id).sort(),
        },
        source_counts: {
          leases: (leases ?? []).length,
          expenses: (expenses ?? []).length,
          revenues: (revenues ?? []).length,
        },
        source_snapshot_ids: {
          revenue: revenueSnapshot.id,
          expense: expenseSnapshot.id,
          cam: camSnapshot?.[0]?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: {
      budget_id: budgetId,
      status: "draft",
      line_items: lineItems,
    },
  };

  const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: snapshotPayload.inputs,
    outputs: snapshotPayload.outputs,
    computed_by: userId,
  });

  if (existingSnapshot?.outputs?.budget_id) {
    return new Response(
      JSON.stringify({
        error: false,
        property_id: propertyId,
        fiscal_year: fiscalYear,
        budget_id: existingSnapshot.outputs.budget_id,
        status: existingSnapshot.outputs.status ?? "draft",
        line_items: existingSnapshot.outputs.line_items ?? lineItems,
        snapshot_id: existingSnapshot.id,
        reused_snapshot: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const newSnapshotId = await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    inputs: snapshotPayload.inputs,
    outputs: snapshotPayload.outputs,
  });

  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: propertyId,
      entity_type: "computation_snapshots",
      entity_id: newSnapshotId ?? null,
      action: "budget_generated",
      actor_user_id: userId,
      source: "edge_function",
      severity: "info",
      metadata: {
        fiscal_year: fiscalYear,
        engine_type: "budget",
        engine_version: ENGINE_VERSION,
        snapshot_id: newSnapshotId ?? null,
        budget_id: budgetId,
        total_revenue: round2(totalRevenue),
        total_expenses: round2(totalExpenses),
        noi: noi,
      },
    });
  } catch (auditErr) {
    console.error("[compute-budget] audit_log insert error (budget_generated):", auditErr?.message || auditErr);
  }

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
  requiredStatus: string | string[],
  newStatus: string,
  successMessage: string
) {
  const requiredStatuses = Array.isArray(requiredStatus) ? requiredStatus : [requiredStatus];
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

  if (!requiredStatuses.includes(budget.status)) {
    throw new Error(
      `Budget status must be ${requiredStatuses.map((s) => `'${s}'`).join(" or ")} to perform this action. Current status: '${budget.status}'`
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
  const auditAction = newStatus === "approved" ? "budget_approved" : "budget_rejected";
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, auditAction, successMessage);

  const { data: latestSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "budget")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    inputs: {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      action: newStatus,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "computation_snapshots"],
        source_snapshot_ids: {
          prior_budget_snapshot: latestSnapshot?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: {
      ...(latestSnapshot?.outputs ?? {}),
      budget_id: budget.id,
      status: newStatus,
      message: successMessage,
    },
  });

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
// Action: mark_reviewed
// =================================================================
async function handleMarkReviewed(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  propertyId: string,
  fiscalYear: number
) {
  const ALLOWED_FROM = ["draft", "ai_generated", "under_review"];

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
  if (!ALLOWED_FROM.includes(budget.status)) {
    throw new Error(
      `Budget status must be one of ${ALLOWED_FROM.map((s) => `'${s}'`).join(", ")} to mark as reviewed. Current status: '${budget.status}'`
    );
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "reviewed",
      reviewed_at: now,
      reviewed_by: userId,
      updated_at: now,
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to mark budget as reviewed: ${updateErr.message}`);
  }

  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, "budget_marked_reviewed", "Budget marked as reviewed");

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      status: "reviewed",
      message: "Budget marked as reviewed",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: reject (rework)
// =================================================================
async function handleReject(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  propertyId: string,
  fiscalYear: number,
  reason: string | null
) {
  const BLOCKED_FROM = ["approved", "locked", "signed"];
  const trimmedReason = (reason ?? "").trim();

  if (!trimmedReason) {
    throw new Error("A rejection reason is required");
  }

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
  if (BLOCKED_FROM.includes(budget.status)) {
    throw new Error(
      `Budget status '${budget.status}' cannot be rejected. Reject is blocked once a budget is approved, locked, or signed.`
    );
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "draft",
      rejected_at: now,
      rejected_by: userId,
      rejection_comment: trimmedReason,
      updated_at: now,
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to reject budget: ${updateErr.message}`);
  }

  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, "budget_rejected", `Budget rejected and returned to draft: ${trimmedReason}`);

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      status: "draft",
      rejection_comment: trimmedReason,
      message: "Budget rejected and returned to draft",
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
    .select("id, outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "budget")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
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

  const lockTimestamp = new Date().toISOString();

  await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    locked_at: lockTimestamp,
    locked_by: userId,
    inputs: {
      ...baselinePayload.inputs,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "computation_snapshots"],
        source_snapshot_ids: {
          prior_budget_snapshot: latestSnapshot?.[0]?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: baselinePayload.outputs,
  });

  // Create audit log entry
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, propertyId, fiscalYear, "budget_locked", "Budget locked successfully");

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
  auditAction: string,
  message: string
) {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: propertyId,
      entity_type: "budget",
      entity_id: budgetId,
      action: auditAction,
      actor_user_id: userId,
      source: "edge_function",
      severity: "info",
      metadata: {
        property_id: propertyId,
        fiscal_year: fiscalYear,
        message,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.error("[compute-budget] audit_log insert error:", auditErr?.message || auditErr);
  }
}
