// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

/**
 * generate-budget Edge Function
 *
 * Uses Vertex AI (Gemini) to generate realistic CRE budget projections
 * based on property details, active leases, and budget parameters.
 *
 * Falls back to formula-based estimation when Vertex AI is unavailable.
 *
 * Request body: {
 *   scope_label: string,
 *   budget_year: number,
 *   scope: string,
 *   period: string,
 *   method: string,
 *   leases?: Array<{ tenant_name: string, annual_rent: number }>
 * }
 */

interface BudgetResult {
  total_revenue: number;
  total_expenses: number;
  cam_total: number;
  noi: number;
  ai_insights: string;
}

function estimateBudget(
  leases: Array<{ tenant_name: string; annual_rent: number }>,
  budgetYear: number,
): BudgetResult {
  const totalRent = leases.reduce((sum, l) => sum + (l.annual_rent || 0), 0);
  const baseRevenue = totalRent || 669000;
  const camTotal = Math.round(baseRevenue * 0.109);
  const totalRevenue = baseRevenue + camTotal;
  const totalExpenses = Math.round(totalRevenue * 0.347);
  const noi = totalRevenue - totalExpenses;

  return {
    total_revenue: totalRevenue,
    total_expenses: totalExpenses,
    cam_total: camTotal,
    noi,
    ai_insights: `Estimated for FY${budgetYear} based on ${leases.length} active lease(s) with total annual rent of $${baseRevenue.toLocaleString()}.`,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const {
      scope_label = "Property",
      budget_year = new Date().getFullYear() + 1,
      scope = "property",
      period = "annual",
      method = "lease_driven",
      leases = [],
    } = body;

    const hasVertexAI = !!Deno.env.get("VERTEX_PROJECT_ID") && !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

    if (!hasVertexAI) {
      console.warn("[generate-budget] Vertex AI not configured — using formula-based estimation");
      return new Response(
        JSON.stringify(estimateBudget(leases, budget_year)),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const leaseContext = leases.length > 0
      ? `Active leases: ${leases.map((l: any) => `${l.tenant_name} - $${l.annual_rent}/yr`).join(", ")}`
      : "No active leases on file.";

    const result = await callVertexAIJSON<BudgetResult>({
      systemPrompt: `You are a commercial real estate financial analyst. Generate realistic budget projections based on provided property and lease data. Use industry-standard CRE expense ratios and market benchmarks. Return only valid JSON.`,
      userPrompt: `Generate a commercial real estate budget for "${scope_label}", fiscal year ${budget_year}.
Scope: ${scope}, Period: ${period}, Method: ${method}.
${leaseContext}

Return a JSON object with these exact fields:
{
  "total_revenue": number (annual USD),
  "total_expenses": number (annual USD),
  "cam_total": number (annual CAM charges USD),
  "noi": number (net operating income USD),
  "ai_insights": "string with 1-2 sentences of insights about the budget"
}

Use realistic CRE ratios: operating expenses typically 30-45% of revenue, CAM typically 8-15% of base rent.`,
      maxOutputTokens: 1024,
      temperature: 0.2,
    });

    if (!result) {
      console.warn("[generate-budget] Vertex AI returned null — using fallback");
      return new Response(
        JSON.stringify(estimateBudget(leases, budget_year)),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[generate-budget] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
