// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { evaluateFinancialControls } from "../_shared/financial-controls/financial-controls-engine.ts";
import { financialSeverity, writeOperationalAudit } from "../_shared/operational-audit.ts";
import { resolveFinancialControlPolicyDecision } from "../_shared/financial-controls/financial-control-policy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|invalid/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["BudgetDashboard", "CreateBudget", "Expenses"], "read");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body.property_id ?? body.propertyId ?? "").trim();
    const fiscalYear = Number(body.fiscal_year ?? body.fiscalYear);
    const varianceThresholdPercent = body.variance_threshold_percent == null
      ? undefined
      : Number(body.variance_threshold_percent);

    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!Number.isInteger(fiscalYear)) throw new Error("fiscal_year is required");
    if (varianceThresholdPercent != null && (!Number.isFinite(varianceThresholdPercent) || varianceThresholdPercent < 0)) {
      throw new Error("variance_threshold_percent is invalid");
    }
    await assertPropertyAccess(req, propertyId);

    const [{ data: expenses, error: expenseError }, { data: budgets, error: budgetError }] = await Promise.all([
      supabaseAdmin
        .from("expenses")
        .select("*")
        .eq("org_id", orgId)
        .eq("property_id", propertyId)
        .eq("fiscal_year", fiscalYear),
      supabaseAdmin
        .from("budgets")
        .select("*")
        .eq("org_id", orgId)
        .eq("property_id", propertyId)
        .eq("budget_year", fiscalYear)
        .in("status", ["approved", "locked"]),
    ]);
    if (expenseError) throw new Error(`Failed to load expenses: ${expenseError.message}`);
    if (budgetError) throw new Error(`Failed to load budgets: ${budgetError.message}`);

    const result = evaluateFinancialControls({
      expenses: expenses ?? [],
      budgets: budgets ?? [],
      fiscalYear,
      varianceThresholdPercent,
    });

    let savedFindings = [];
    let policyRows = [];
    if (Array.isArray(result.exceptions) && result.exceptions.length > 0) {
      const { data: policies, error: policyError } = await supabaseAdmin
        .from("financial_control_policies")
        .select("*")
        .eq("org_id", orgId)
        .eq("is_active", true)
        .or(`property_id.is.null,property_id.eq.${propertyId}`);
      if (policyError) throw new Error(`Failed to load financial control policies: ${policyError.message}`);
      policyRows = policies ?? [];

      const rows = result.exceptions.map((exception: Record<string, unknown>) => {
        const severity = financialSeverity(exception);
        const varianceAmount = Number.isFinite(Number(exception.actual)) && Number.isFinite(Number(exception.budget))
          ? Number(exception.actual) - Number(exception.budget)
          : null;
        const baseFinding = {
          org_id: orgId,
          property_id: propertyId,
          workflow: String(body.workflow || body.workflow_type || "budget_approval"),
          fiscal_year: fiscalYear,
          code: String(exception.code || "UNKNOWN_FINANCIAL_CONTROL"),
          category: String(exception.category || "uncategorized"),
          severity,
          budget_amount: exception.budget ?? null,
          actual_amount: exception.actual ?? null,
          variance_amount: varianceAmount,
          variance_percent: exception.variancePercent ?? null,
          status: "open",
          finding_snapshot: exception,
          source: "run-financial-controls",
        };
        const policyDecision = resolveFinancialControlPolicyDecision({
          finding: baseFinding,
          policies: policyRows,
          workflow: baseFinding.workflow,
          missingPolicyBehavior: body.missing_policy_behavior || body.missingPolicyBehavior || null,
        });
        return {
          ...baseFinding,
          policy_action: policyDecision.action,
          policy_blocks: policyDecision.blocks,
          policy_decision_snapshot: policyDecision.snapshot,
          policy_resolved_at: policyDecision.snapshot.resolved_at,
        };
      });
      const { data: saved, error: saveError } = await supabaseAdmin
        .from("financial_control_findings")
        .upsert(rows, { onConflict: "org_id,property_id,fiscal_year,code,category" })
        .select("*");
      if (saveError) throw new Error(`Failed to persist financial control findings: ${saveError.message}`);
      savedFindings = saved ?? [];
    }

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "financial_control_run",
      entityId: `${propertyId}:${fiscalYear}`,
      action: "FINANCIAL_CONTROLS_RUN",
      actorEmail: user.email || null,
      actorUserId: user.id,
      propertyId,
      newValue: { result, saved_findings: savedFindings.length },
      source: "run-financial-controls",
    });

    return jsonResponse({ error: false, data: { ...result, saved_findings: savedFindings } });
  } catch (error) {
    const message = error?.message || "Could not run financial controls";
    console.error("[run-financial-controls]", message);
    return jsonResponse({ error: true, message, error_code: "RUN_FINANCIAL_CONTROLS_FAILED" }, errorStatus(message));
  }
});
