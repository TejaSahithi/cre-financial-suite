// @ts-nocheck
/**
 * budget-tools.ts — section 16 "BUDGET". Reads canonical planning-truth
 * sources only (section 8.3): budgets/budget_line_items (compute-budget),
 * the budget_basis computation_snapshots row (compute-budget-basis), and
 * variances (compute-reconciliation). Never presents these as actual spend
 * and never recomputes them.
 */
import type { AssistantTool } from "../assistant-contracts.ts";

const PROPERTY_ID_PROP = { type: "string", description: "UUID of the property (used for authorization)." };
const BUDGET_ID_PROP = { type: "string", description: "UUID of the budget." };

async function loadBudget(ctx: any, orgId: string, propertyId: string, budgetId: string) {
  const { data: budget, error } = await ctx.supabaseAdmin
    .from("budgets")
    .select("*")
    .eq("id", budgetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load budget: ${error.message}`);
  if (!budget || budget.property_id !== propertyId) return null;
  return budget;
}

export const getBudgetSummaryTool: AssistantTool = {
  name: "get_budget_summary",
  description:
    "Get a budget's status (draft/under_review/approved/locked), fiscal year, revenue/expense totals, and a category-level expense breakdown. Use for 'what is this budget based on' overview questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "budget_id"],
    properties: { property_id: PROPERTY_ID_PROP, budget_id: BUDGET_ID_PROP },
  },
  requiredPages: ["BudgetDashboard"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const budget = await loadBudget(ctx, ctx.orgId, String(args.property_id), String(args.budget_id));
    if (!budget) {
      return { status: "no_data", data: null, message: "No budget found for the given id under this property." };
    }

    const { data: lines, error } = await ctx.supabaseAdmin
      .from("budget_line_items")
      .select("category, line_type, amount")
      .eq("org_id", ctx.orgId)
      .eq("budget_id", budget.id);
    if (error) throw new Error(`Failed to load budget line items: ${error.message}`);

    const byCategory = new Map<string, number>();
    for (const line of lines ?? []) {
      const key = `${line.line_type}:${line.category}`;
      byCategory.set(key, (byCategory.get(key) ?? 0) + Number(line.amount ?? 0));
    }
    const categories = [...byCategory.entries()]
      .map(([key, amount]) => {
        const [line_type, category] = key.split(":");
        return { line_type, category, amount };
      })
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 20);

    return {
      status: "answered",
      data: {
        budget: { id: budget.id, name: budget.name, budget_year: budget.budget_year, status: budget.status, total_revenue: budget.total_revenue, total_expenses: budget.total_expenses, approved_at: budget.approved_at ?? null, locked_at: budget.locked_at ?? null },
        categories,
      },
      citations: [{ type: "budget_record", label: `Budget: ${budget.name} (FY${budget.budget_year})`, entityId: budget.id }],
    };
  },
};

export const getBudgetLineBasisTool: AssistantTool = {
  name: "get_budget_line_basis",
  description:
    "Get the basis/assumption behind a budget's expense category: prior-year actual, current-year forecast, the % assumption applied, any manual override, and a plain-language explanation. Use for 'why did this category increase/decrease' and 'what assumption drove this' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "budget_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      budget_id: BUDGET_ID_PROP,
      category: { type: "string", description: "Optional expense category label to filter to, e.g. \"Utilities\". Omit for all categories." },
    },
  },
  requiredPages: ["BudgetDashboard", "CreateBudget"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const budget = await loadBudget(ctx, ctx.orgId, String(args.property_id), String(args.budget_id));
    if (!budget) {
      return { status: "no_data", data: null, message: "No budget found for the given id under this property." };
    }

    const { data: snapshot, error } = await ctx.supabaseAdmin
      .from("computation_snapshots")
      .select("*")
      .eq("org_id", ctx.orgId)
      .eq("property_id", String(args.property_id))
      .eq("engine_type", "budget_basis")
      .eq("fiscal_year", budget.budget_year)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load budget basis snapshot: ${error.message}`);
    if (!snapshot) {
      return { status: "no_data", data: null, message: "No expense-basis computation exists yet for this budget." };
    }

    let categories = snapshot.outputs?.categories ?? [];
    if (args.category) {
      const needle = String(args.category).toLowerCase();
      categories = categories.filter((c: any) => String(c.category_label ?? "").toLowerCase().includes(needle));
      if (categories.length === 0) {
        return { status: "no_data", data: null, message: `No basis data found for category "${args.category}".` };
      }
    } else {
      categories = categories.slice(0, 25);
    }

    return {
      status: "answered",
      data: {
        fiscal_year: budget.budget_year,
        categories: categories.map((c: any) => ({
          category_label: c.category_label,
          prior_year_actual: c.prior_year_actual,
          current_year_ytd_actual: c.current_year_ytd_actual,
          current_year_forecast: c.current_year_forecast,
          baseline_type: c.baseline_type,
          assumption: c.assumption,
          override: c.override,
          annual_budget: c.annual_budget,
          source_basis_explanation: c.source_basis_explanation,
        })),
      },
      citations: [{ type: "budget_basis", label: `Budget basis FY${budget.budget_year}`, entityId: snapshot.id }],
    };
  },
};

export const getBudgetVarianceTool: AssistantTool = {
  name: "get_budget_variance",
  description:
    "Get budget-vs-actual variance by category for a property/fiscal year, ranked by largest variance first. Use for 'explain the largest variance' / 'which assumption caused this variance' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "fiscal_year"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      fiscal_year: { type: "number", description: "Fiscal year, e.g. 2026." },
    },
  },
  requiredPages: ["Variance", "ActualsVariance", "BudgetDashboard"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: rows, error } = await ctx.supabaseAdmin
      .from("variances")
      .select("category, month, budget_amount, actual_amount, variance_amount, variance_pct, notes")
      .eq("org_id", ctx.orgId)
      .eq("property_id", String(args.property_id))
      .eq("fiscal_year", Number(args.fiscal_year))
      .limit(200);
    if (error) throw new Error(`Failed to load variances: ${error.message}`);
    if (!rows || rows.length === 0) {
      return { status: "no_data", data: null, message: `No variance computation exists yet for fiscal year ${args.fiscal_year}.` };
    }

    const top = [...rows].sort((a, b) => Math.abs(Number(b.variance_amount ?? 0)) - Math.abs(Number(a.variance_amount ?? 0))).slice(0, 15);

    return {
      status: "answered",
      data: { fiscal_year: Number(args.fiscal_year), top_variances: top },
      citations: [{ type: "variance", label: `Budget variance FY${args.fiscal_year}` }],
    };
  },
};

export const getBudgetCamEstimateTool: AssistantTool = {
  name: "get_budget_cam_estimate",
  description:
    "Get a budget's estimated CAM/tenant-recovery line items (produced by re-running the real CAM engine against projected budget-year inputs, not a separate estimate). Use for 'what is the budgeted CAM recovery' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "budget_id"],
    properties: { property_id: PROPERTY_ID_PROP, budget_id: BUDGET_ID_PROP },
  },
  requiredPages: ["BudgetDashboard", "CAMSetup"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const budget = await loadBudget(ctx, ctx.orgId, String(args.property_id), String(args.budget_id));
    if (!budget) {
      return { status: "no_data", data: null, message: "No budget found for the given id under this property." };
    }

    const { data: lines, error } = await ctx.supabaseAdmin
      .from("budget_line_items")
      .select("category, subcategory, line_type, amount, notes")
      .eq("org_id", ctx.orgId)
      .eq("budget_id", budget.id)
      .ilike("category", "%cam%")
      .limit(50);
    if (error) throw new Error(`Failed to load budget CAM lines: ${error.message}`);
    if (!lines || lines.length === 0) {
      return { status: "no_data", data: null, message: "No CAM estimate line items exist yet for this budget." };
    }

    const total = lines.reduce((sum: number, l: any) => sum + Number(l.amount ?? 0), 0);
    return {
      status: "answered",
      data: { fiscal_year: budget.budget_year, total_estimated_cam: total, line_items: lines },
      citations: [{ type: "budget_cam_estimate", label: `Budget CAM estimate FY${budget.budget_year}`, entityId: budget.id }],
    };
  },
};

export const getReconciliationSummaryTool: AssistantTool = {
  name: "get_reconciliation_summary",
  description:
    "Get a property's operating-cost reconciliation for a fiscal year: total recoverable, total billed to tenants, and the resulting due/credit variance. Use for 'what is the reconciliation' / 'do we owe tenants money' questions — this is the CAM-focused counterpart to get_budget_variance's category-level view.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "fiscal_year"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      fiscal_year: { type: "number", description: "Fiscal year, e.g. 2026." },
    },
  },
  requiredPages: ["Reconciliation"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: row, error } = await ctx.supabaseAdmin
      .from("reconciliations")
      .select("status, total_recoverable, total_billed, variance, completed_at, notes")
      .eq("org_id", ctx.orgId)
      .eq("property_id", String(args.property_id))
      .eq("fiscal_year", Number(args.fiscal_year))
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load reconciliation: ${error.message}`);
    if (!row) {
      return { status: "no_data", data: null, message: `No reconciliation exists yet for fiscal year ${args.fiscal_year}.` };
    }

    return {
      status: "answered",
      data: {
        fiscal_year: Number(args.fiscal_year),
        status: row.status,
        total_recoverable: row.total_recoverable,
        total_billed: row.total_billed,
        variance: row.variance,
        position: Number(row.variance) > 0 ? "tenants_owe_landlord" : Number(row.variance) < 0 ? "landlord_owes_tenants" : "even",
        completed_at: row.completed_at,
        notes: row.notes,
      },
      citations: [{ type: "reconciliation", label: `Reconciliation FY${args.fiscal_year}` }],
    };
  },
};

export const budgetTools: AssistantTool[] = [
  getBudgetSummaryTool,
  getBudgetLineBasisTool,
  getBudgetVarianceTool,
  getBudgetCamEstimateTool,
  getReconciliationSummaryTool,
];
