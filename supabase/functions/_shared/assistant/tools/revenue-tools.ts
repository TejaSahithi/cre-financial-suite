// @ts-nocheck
/**
 * revenue-tools.ts — section 16 "REVENUE". Reads the persisted
 * computation_snapshots row compute-revenue/index.ts already writes
 * (engine_type='revenue') — never recomputes. Consolidates
 * get_revenue_summary / get_rent_revenue / get_cam_revenue / get_other_income
 * into one tool since they're all fields of the same
 * summary.revenue_by_type payload.
 */
import type { AssistantTool } from "../assistant-contracts.ts";

export const getRevenueSummaryTool: AssistantTool = {
  name: "get_revenue_summary",
  description:
    "Get a property's revenue projection for a fiscal year: base rent, CAM recovery (sourced from posted CAM runs), and other income. Use for revenue-breakdown questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "fiscal_year"],
    properties: {
      property_id: { type: "string", description: "UUID of the property." },
      fiscal_year: { type: "number", description: "Fiscal year, e.g. 2026." },
    },
  },
  requiredPages: ["Revenue"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const fiscalYear = Number(args.fiscal_year);

    const { data: snapshot, error } = await ctx.supabaseAdmin
      .from("computation_snapshots")
      .select("*")
      .eq("org_id", ctx.orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "revenue")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load revenue snapshot: ${error.message}`);
    if (!snapshot) {
      return { status: "no_data", data: null, message: `No revenue computation exists yet for fiscal year ${fiscalYear}.` };
    }

    const summary = snapshot.outputs?.summary ?? snapshot.outputs ?? {};
    return {
      status: "answered",
      data: {
        fiscal_year: fiscalYear,
        computed_at: snapshot.computed_at,
        revenue_by_type: summary.revenue_by_type ?? null,
        total_revenue: summary.total_revenue ?? null,
      },
      citations: [{ type: "revenue_snapshot", label: `Revenue projection FY${fiscalYear}`, entityId: snapshot.id }],
    };
  },
};

export const revenueTools: AssistantTool[] = [getRevenueSummaryTool];
