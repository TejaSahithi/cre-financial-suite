// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";
import { createAdminClient } from "../_shared/supabase.ts";

/**
 * generate-budget Edge Function
 *
 * Uses Vertex AI (Gemini) to generate realistic CRE budget projections
 * based on property details, active leases, uploaded historical budgets,
 * and budget parameters.
 *
 * Falls back to formula-based estimation when Vertex AI is unavailable.
 *
 * Request body: {
 *   scope_label: string,
 *   budget_year: number,
 *   scope: string,
 *   period: string,
 *   method: string,
 *   leases?: Array<{ tenant_name: string, annual_rent: number }>,
 *   historical_file_ids?: string[]
 * }
 */

interface BudgetResult {
  total_revenue: number;
  total_expenses: number;
  cam_total: number;
  noi: number;
  ai_insights: string;
}

interface HistoricalSummary {
  files: Array<{
    file_id: string;
    file_name: string;
    module_type: string | null;
    status: string | null;
    row_count: number;
    sample_rows: Record<string, unknown>[];
    totals: {
      revenue: number | null;
      expenses: number | null;
      cam: number | null;
      noi: number | null;
    };
  }>;
  aggregate: {
    revenue: number;
    expenses: number;
    cam: number;
    noi: number;
    has_any_numbers: boolean;
  };
}

const REVENUE_KEYWORDS = ["revenue", "income", "gross rent", "total rent", "rental income", "gross income"];
const EXPENSE_KEYWORDS = ["expense", "operating expense", "opex", "total expense"];
const CAM_KEYWORDS = ["cam", "common area"];
const NOI_KEYWORDS = ["noi", "net operating income"];

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function extractRowsFromFile(fileRecord: any): Record<string, unknown>[] {
  const candidates = [
    fileRecord?.valid_data,
    fileRecord?.parsed_data,
    fileRecord?.normalized_output?.rows,
    fileRecord?.normalized_output?.records,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.filter((row) => row && typeof row === "object");
    }
  }
  return [];
}

function deriveTotalsFromRows(rows: Record<string, unknown>[]) {
  let revenue = 0;
  let expenses = 0;
  let cam = 0;
  let noi: number | null = null;
  let revenueSeen = false;
  let expensesSeen = false;
  let camSeen = false;

  for (const row of rows) {
    const entries = Object.entries(row);
    const labelFields = entries.filter(([, value]) => typeof value === "string");
    const label = labelFields.map(([, value]) => String(value)).join(" ") +
      " " + Object.keys(row).join(" ");

    const amountValues = entries
      .map(([, value]) => toNumber(value))
      .filter((value): value is number => value !== null);

    if (amountValues.length === 0) continue;
    const amount = amountValues[amountValues.length - 1];

    if (matchKeyword(label, NOI_KEYWORDS)) {
      noi = amount;
      continue;
    }
    if (matchKeyword(label, CAM_KEYWORDS)) {
      cam += amount;
      camSeen = true;
      continue;
    }
    if (matchKeyword(label, REVENUE_KEYWORDS)) {
      revenue += amount;
      revenueSeen = true;
      continue;
    }
    if (matchKeyword(label, EXPENSE_KEYWORDS)) {
      expenses += amount;
      expensesSeen = true;
      continue;
    }
  }

  return {
    revenue: revenueSeen ? revenue : null,
    expenses: expensesSeen ? expenses : null,
    cam: camSeen ? cam : null,
    noi,
  };
}

async function loadHistoricalSummary(
  supabaseAdmin: any,
  fileIds: string[],
  orgId: string | null,
): Promise<HistoricalSummary> {
  const summary: HistoricalSummary = {
    files: [],
    aggregate: { revenue: 0, expenses: 0, cam: 0, noi: 0, has_any_numbers: false },
  };
  if (!fileIds.length) return summary;

  let query = supabaseAdmin
    .from("uploaded_files")
    .select("id, org_id, file_name, module_type, status, parsed_data, valid_data, normalized_output, row_count")
    .in("id", fileIds);
  if (orgId) query = query.eq("org_id", orgId);

  const { data, error } = await query;
  if (error) {
    console.error("[generate-budget] Failed to load historical files:", error.message);
    return summary;
  }

  const perCategoryAgg = { revenue: 0, expenses: 0, cam: 0, noi: 0 };
  const seen = { revenue: false, expenses: false, cam: false, noi: false };

  for (const fileRecord of data ?? []) {
    const rows = extractRowsFromFile(fileRecord);
    const totals = deriveTotalsFromRows(rows);
    summary.files.push({
      file_id: fileRecord.id,
      file_name: fileRecord.file_name,
      module_type: fileRecord.module_type,
      status: fileRecord.status,
      row_count: rows.length || fileRecord.row_count || 0,
      sample_rows: rows.slice(0, 12),
      totals,
    });

    if (totals.revenue !== null) { perCategoryAgg.revenue += totals.revenue; seen.revenue = true; }
    if (totals.expenses !== null) { perCategoryAgg.expenses += totals.expenses; seen.expenses = true; }
    if (totals.cam !== null) { perCategoryAgg.cam += totals.cam; seen.cam = true; }
    if (totals.noi !== null) { perCategoryAgg.noi += totals.noi; seen.noi = true; }
  }

  const fileCount = summary.files.length || 1;
  summary.aggregate.revenue = seen.revenue ? perCategoryAgg.revenue / fileCount : 0;
  summary.aggregate.expenses = seen.expenses ? perCategoryAgg.expenses / fileCount : 0;
  summary.aggregate.cam = seen.cam ? perCategoryAgg.cam / fileCount : 0;
  summary.aggregate.noi = seen.noi ? perCategoryAgg.noi / fileCount : 0;
  summary.aggregate.has_any_numbers = seen.revenue || seen.expenses || seen.cam || seen.noi;

  return summary;
}

async function resolveOrgIdFromAuth(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? req.headers.get("x-supabase-auth") ?? "";
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const supabaseAdmin = createAdminClient();
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: memberships } = await supabaseAdmin
      .from("memberships")
      .select("org_id")
      .eq("user_id", data.user.id);
    const withOrg = (memberships ?? []).find((m: any) => m.org_id);
    return withOrg?.org_id ?? null;
  } catch {
    return null;
  }
}

function estimateBudget(
  leases: Array<{ tenant_name: string; annual_rent: number }>,
  budgetYear: number,
  historical: HistoricalSummary | null,
): BudgetResult {
  const totalRent = leases.reduce((sum, l) => sum + (l.annual_rent || 0), 0);
  const historicalRevenue = historical?.aggregate?.revenue || 0;
  const historicalExpenses = historical?.aggregate?.expenses || 0;
  const historicalCam = historical?.aggregate?.cam || 0;
  const historicalNoi = historical?.aggregate?.noi || 0;

  const GROWTH = 1.03; // 3% nominal growth vs historical average

  let baseRevenue: number;
  let camTotal: number;
  let totalRevenue: number;
  let totalExpenses: number;
  let noi: number;
  let insightSource: string;

  if (historical?.aggregate?.has_any_numbers && historicalRevenue > 0) {
    baseRevenue = Math.round(historicalRevenue * GROWTH);
    camTotal = Math.round((historicalCam > 0 ? historicalCam : baseRevenue * 0.109) * GROWTH);
    totalRevenue = baseRevenue + (historicalCam > 0 ? 0 : camTotal);
    totalExpenses = Math.round((historicalExpenses > 0 ? historicalExpenses : totalRevenue * 0.347) * GROWTH);
    noi = historicalNoi > 0 ? Math.round(historicalNoi * GROWTH) : totalRevenue - totalExpenses;
    insightSource = `derived from ${historical.files.length} historical file(s) with ${GROWTH === 1.03 ? "3%" : ""} growth applied`;
  } else {
    baseRevenue = totalRent || 669000;
    camTotal = Math.round(baseRevenue * 0.109);
    totalRevenue = baseRevenue + camTotal;
    totalExpenses = Math.round(totalRevenue * 0.347);
    noi = totalRevenue - totalExpenses;
    insightSource = `based on ${leases.length} active lease(s) with total annual rent of $${baseRevenue.toLocaleString()}`;
  }

  return {
    total_revenue: totalRevenue,
    total_expenses: totalExpenses,
    cam_total: camTotal,
    noi,
    ai_insights: `Estimated for FY${budgetYear} ${insightSource}.`,
  };
}

function buildHistoricalContext(historical: HistoricalSummary): string {
  if (!historical.files.length) return "No historical files provided.";
  const lines: string[] = [
    `Historical files reviewed (${historical.files.length}):`,
  ];
  for (const file of historical.files) {
    const totalsBits: string[] = [];
    if (file.totals.revenue !== null) totalsBits.push(`revenue=$${file.totals.revenue.toLocaleString()}`);
    if (file.totals.expenses !== null) totalsBits.push(`expenses=$${file.totals.expenses.toLocaleString()}`);
    if (file.totals.cam !== null) totalsBits.push(`cam=$${file.totals.cam.toLocaleString()}`);
    if (file.totals.noi !== null) totalsBits.push(`noi=$${file.totals.noi.toLocaleString()}`);
    lines.push(`- ${file.file_name} [${file.module_type ?? "unknown"}]: ${file.row_count} rows${totalsBits.length ? `; ${totalsBits.join(", ")}` : ""}`);
    if (file.sample_rows.length) {
      lines.push(`  sample rows: ${JSON.stringify(file.sample_rows).slice(0, 1500)}`);
    }
  }
  if (historical.aggregate.has_any_numbers) {
    lines.push(
      `Aggregated averages — revenue=$${Math.round(historical.aggregate.revenue).toLocaleString()}, ` +
      `expenses=$${Math.round(historical.aggregate.expenses).toLocaleString()}, ` +
      `cam=$${Math.round(historical.aggregate.cam).toLocaleString()}, ` +
      `noi=$${Math.round(historical.aggregate.noi).toLocaleString()}.`
    );
  }
  return lines.join("\n");
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
      historical_file_ids = [],
    } = body;

    const fileIds = Array.isArray(historical_file_ids)
      ? historical_file_ids.filter((id: unknown) => typeof id === "string" && id.length > 0)
      : [];

    let historical: HistoricalSummary | null = null;
    if (fileIds.length > 0) {
      const orgId = await resolveOrgIdFromAuth(req);
      const supabaseAdmin = createAdminClient();
      historical = await loadHistoricalSummary(supabaseAdmin, fileIds, orgId);
      console.log(
        `[generate-budget] Loaded ${historical.files.length}/${fileIds.length} historical files; ` +
        `aggregate has_any_numbers=${historical.aggregate.has_any_numbers}`,
      );
    }

    const hasVertexAI = !!Deno.env.get("VERTEX_PROJECT_ID") && !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

    if (!hasVertexAI) {
      console.warn("[generate-budget] Vertex AI not configured — using formula-based estimation");
      return new Response(
        JSON.stringify(estimateBudget(leases, budget_year, historical)),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const leaseContext = leases.length > 0
      ? `Active leases: ${leases.map((l: any) => `${l.tenant_name} - $${l.annual_rent}/yr`).join(", ")}`
      : "No active leases on file.";
    const historicalContext = historical ? buildHistoricalContext(historical) : "No historical files provided.";

    const result = await callVertexAIJSON<BudgetResult>({
      systemPrompt: `You are a commercial real estate financial analyst. Generate realistic budget projections based on provided property, lease, and historical budget data. When historical totals are available, anchor the projection to them and apply modest growth (2-4%) unless the data suggests otherwise. Use industry-standard CRE expense ratios and market benchmarks when historical data is insufficient. Return only valid JSON.`,
      userPrompt: `Generate a commercial real estate budget for "${scope_label}", fiscal year ${budget_year}.
Scope: ${scope}, Period: ${period}, Method: ${method}.
${leaseContext}

${historicalContext}

Return a JSON object with these exact fields:
{
  "total_revenue": number (annual USD),
  "total_expenses": number (annual USD),
  "cam_total": number (annual CAM charges USD),
  "noi": number (net operating income USD),
  "ai_insights": "string with 2-3 sentences of insights. If historical data was used, explicitly reference it (e.g., growth vs prior year, category drivers)."
}

Use realistic CRE ratios: operating expenses typically 30-45% of revenue, CAM typically 8-15% of base rent. When historical totals are present, deviate only with a clear reason stated in ai_insights.`,
      maxOutputTokens: 1024,
      temperature: 0.2,
    });

    if (!result) {
      console.warn("[generate-budget] Vertex AI returned null — using fallback");
      return new Response(
        JSON.stringify(estimateBudget(leases, budget_year, historical)),
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
