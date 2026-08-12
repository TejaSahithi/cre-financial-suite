// @ts-nocheck
/**
 * property-tools.ts — section 16 "PROPERTY". Consolidates
 * get_property_summary / get_property_hierarchy / get_property_occupancy_context
 * into one tool: a property's hierarchy counts and occupancy are cheap to
 * compute together and a caller asking about one usually wants the other.
 */
import { assertPortfolioAccess, createUserScopedClient } from "../../supabase.ts";
import type { AssistantTool } from "../assistant-contracts.ts";

export const getPropertySummaryTool: AssistantTool = {
  name: "get_property_summary",
  description:
    "Get a property's core info (name, address, type, status) plus hierarchy counts (buildings, units) and occupancy context (active leases, tenants). Use for 'tell me about this property' / occupancy questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id"],
    properties: {
      property_id: { type: "string", description: "UUID of the property." },
    },
  },
  requiredPages: ["Properties"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const { data: property, error: propertyError } = await ctx.supabaseAdmin
      .from("properties")
      .select("*")
      .eq("id", propertyId)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (propertyError) throw new Error(`Failed to load property: ${propertyError.message}`);
    if (!property) {
      return { status: "no_data", data: null, message: "No property found for the given id in this organization." };
    }

    // Portfolio-scope check (section 6.3) — only relevant when the property
    // actually belongs to a portfolio the caller might not have unrestricted access to.
    if (property.portfolio_id) {
      try {
        await assertPortfolioAccess(ctx.req, property.portfolio_id);
      } catch {
        return { status: "no_data", data: null, message: "This property's portfolio is not accessible with your current permissions." };
      }
    }

    const [{ count: buildingsCount }, { count: unitsCount }, { data: leases }] = await Promise.all([
      ctx.supabaseAdmin.from("buildings").select("id", { count: "exact", head: true }).eq("org_id", ctx.orgId).eq("property_id", propertyId),
      ctx.supabaseAdmin.from("units").select("id", { count: "exact", head: true }).eq("org_id", ctx.orgId).eq("property_id", propertyId),
      ctx.supabaseAdmin.from("leases").select("id, status, tenant_id").eq("org_id", ctx.orgId).eq("property_id", propertyId),
    ]);

    const activeLeases = (leases ?? []).filter((l: any) => l.status === "active");
    const distinctTenants = new Set(activeLeases.map((l: any) => l.tenant_id).filter(Boolean));

    return {
      status: "answered",
      data: {
        property: {
          id: property.id,
          name: property.name,
          address: property.address,
          city: property.city,
          state: property.state,
          property_type: property.property_type,
          status: property.status,
          total_sqft: property.total_sqft,
        },
        hierarchy: { buildings_count: buildingsCount ?? 0, units_count: unitsCount ?? 0 },
        occupancy: { active_leases_count: activeLeases.length, distinct_tenants_count: distinctTenants.size },
      },
      citations: [{ type: "property_record", label: `Property: ${property.name}`, entityId: property.id }],
    };
  },
};

function sumBy<T>(rows: T[], keyFn: (row: T) => string | null | undefined, amountFn: (row: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + amountFn(row);
  }
  return out;
}

export const getPropertyListSummaryTool: AssistantTool = {
  name: "get_property_list_summary",
  description:
    "List and summarize properties the current user can access, with optional top expense totals and budget-review signals. Use for portfolio/property-list questions like 'which properties can I access' or 'which properties have the largest expenses'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      focus: { type: "string", enum: ["overview", "largest_expenses", "budget_review"], description: "Optional summary focus. Defaults to overview." },
      fiscal_year: { type: "number", description: "Optional fiscal year for budget/expense filters." },
      limit: { type: "number", description: "Optional result cap; max 25." },
    },
  },
  requiredPages: ["Properties"],
  scopeType: "none",
  accessType: "business_data",
  async execute(args, ctx) {
    const client = createUserScopedClient(ctx.req);
    const limit = Math.max(1, Math.min(Number(args.limit ?? 10), 25));
    const focus = String(args.focus ?? "overview");

    const { data: properties, error: propertyError } = await client
      .from("properties")
      .select("id, name, address, city, state, property_type, status, total_sqft, portfolio_id")
      .eq("org_id", ctx.orgId)
      .limit(100);
    if (propertyError) throw new Error(`Failed to load accessible properties: ${propertyError.message}`);

    const accessibleProperties = properties ?? [];
    if (accessibleProperties.length === 0) {
      return { status: "no_data", data: null, message: "No accessible properties were found for your current organization and permissions." };
    }

    const propertyIds = accessibleProperties.map((p: any) => p.id);
    let expenseTotals: Record<string, number> = {};
    let budgetSignals: any[] = [];
    const limitations: string[] = [];

    if ((focus === "largest_expenses" || focus === "overview") && propertyIds.length > 0) {
      let expenseQuery = client
        .from("expenses")
        .select("property_id, amount, fiscal_year")
        .eq("org_id", ctx.orgId)
        .in("property_id", propertyIds)
        .limit(1000);
      if (typeof args.fiscal_year === "number") expenseQuery = expenseQuery.eq("fiscal_year", Number(args.fiscal_year));
      const { data: expenses, error: expenseError } = await expenseQuery;
      if (expenseError) throw new Error(`Failed to load accessible expense totals: ${expenseError.message}`);
      if ((expenses ?? []).length >= 1000) limitations.push("Expense totals are based on the first 1,000 authorized expense rows returned by the platform.");
      expenseTotals = sumBy(expenses ?? [], (row: any) => row.property_id, (row: any) => Number(row.amount ?? 0));
    }

    if ((focus === "budget_review" || focus === "overview") && propertyIds.length > 0) {
      let budgetQuery = client
        .from("budgets")
        .select("id, property_id, name, budget_year, status, total_expenses, total_revenue")
        .eq("org_id", ctx.orgId)
        .in("property_id", propertyIds)
        .limit(200);
      if (typeof args.fiscal_year === "number") budgetQuery = budgetQuery.eq("budget_year", Number(args.fiscal_year));
      const { data: budgets, error: budgetError } = await budgetQuery;
      if (budgetError) throw new Error(`Failed to load accessible budget signals: ${budgetError.message}`);
      budgetSignals = (budgets ?? []).filter((b: any) => ["draft", "under_review", "pending_review", "pending_approval", "rejected"].includes(String(b.status ?? "").toLowerCase()));
    }

    const rows = accessibleProperties
      .map((property: any) => ({
        id: property.id,
        name: property.name,
        city: property.city,
        state: property.state,
        property_type: property.property_type,
        status: property.status,
        total_sqft: property.total_sqft,
        expense_total: expenseTotals[property.id] ?? 0,
        budgets_awaiting_review: budgetSignals.filter((b: any) => b.property_id === property.id).length,
      }))
      .sort((a: any, b: any) => focus === "largest_expenses" ? b.expense_total - a.expense_total : String(a.name ?? "").localeCompare(String(b.name ?? "")))
      .slice(0, limit);

    return {
      status: "answered",
      data: {
        focus,
        fiscal_year: typeof args.fiscal_year === "number" ? Number(args.fiscal_year) : null,
        total_accessible_properties: accessibleProperties.length,
        properties: rows,
        budget_review_items: budgetSignals.slice(0, 20).map((b: any) => ({ id: b.id, property_id: b.property_id, name: b.name, budget_year: b.budget_year, status: b.status })),
      },
      citations: [{ type: "property_list", label: "Accessible properties" }],
      ...(limitations.length ? { limitations } : {}),
    };
  },
};

export const propertyTools: AssistantTool[] = [getPropertySummaryTool, getPropertyListSummaryTool];
