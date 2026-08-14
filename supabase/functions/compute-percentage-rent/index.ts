// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { evaluatePercentageRent } from "../_shared/percentage-rent/percentage-rent-evaluator.ts";
import { operationalStatus, writeOperationalAudit } from "../_shared/operational-audit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|invalid/i.test(message)) return 400;
  return 500;
}

function effectiveOn(row: Record<string, unknown>, asOfDate: string) {
  const start = row.effective_start ? String(row.effective_start) : null;
  const end = row.effective_end ? String(row.effective_end) : null;
  return (!start || start <= asOfDate) && (!end || end >= asOfDate);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["RentProjection", "LeaseExpenseRules", "LeaseReview"], "read");

    const body = await req.json().catch(() => ({}));
    const leaseId = String(body.lease_id ?? body.leaseId ?? "").trim();
    const periodStart = String(body.period_start ?? body.periodStart ?? "").trim();
    const periodEnd = String(body.period_end ?? body.periodEnd ?? "").trim();
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? periodEnd ?? "").trim();

    if (!UUID_RE.test(leaseId)) throw new Error("lease_id is required");
    if (!DATE_RE.test(periodStart)) throw new Error("period_start is required in YYYY-MM-DD format");
    if (!DATE_RE.test(periodEnd)) throw new Error("period_end is required in YYYY-MM-DD format");
    if (!DATE_RE.test(asOfDate)) throw new Error("as_of_date is required in YYYY-MM-DD format");

    const { data: lease, error: leaseError } = await supabaseAdmin
      .from("leases")
      .select("id, property_id")
      .eq("org_id", orgId)
      .eq("id", leaseId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease?.id) throw new Error("Lease not found");
    if (lease.property_id) await assertPropertyAccess(req, lease.property_id);

    const { data: termRows, error: termError } = await supabaseAdmin
      .from("lease_percentage_rent_terms")
      .select("*")
      .eq("org_id", orgId)
      .eq("lease_id", leaseId)
      .eq("status", "approved")
      .order("effective_start", { ascending: false, nullsFirst: false })
      .limit(25);
    if (termError) throw new Error(`Failed to load percentage rent terms: ${termError.message}`);

    const term = (termRows ?? []).find((row: Record<string, unknown>) => effectiveOn(row, asOfDate)) ?? null;

    const { data: report, error: reportError } = await supabaseAdmin
      .from("tenant_sales_reports")
      .select("*")
      .eq("org_id", orgId)
      .eq("lease_id", leaseId)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .eq("status", "approved")
      .maybeSingle();
    if (reportError) throw new Error(`Failed to load sales report: ${reportError.message}`);

    const result = evaluatePercentageRent({ term, salesReport: report ?? null, asOfDate });
    const row = {
      org_id: orgId,
      lease_id: leaseId,
      property_id: lease.property_id ?? null,
      percentage_rent_term_id: term?.id ?? null,
      tenant_sales_report_id: report?.id ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      approved_sales: result.inputs?.netSales ?? null,
      breakpoint_amount: result.inputs?.breakpoint ?? null,
      excess_sales: result.inputs?.excessSales ?? null,
      percentage_rate: result.inputs?.percentageRate ?? null,
      calculated_amount: result.amount,
      currency: result.currency || "USD",
      status: operationalStatus(result.status),
      reason_codes: result.reasonCodes ?? [],
      calculation_lines: result.calculationLines ?? [],
      inputs: result.inputs ?? {},
      evidence: result.evidence ?? [],
      calculated_by: user.id,
    };
    const { data: savedCalculation, error: saveError } = await supabaseAdmin
      .from("percentage_rent_calculations")
      .upsert(row, { onConflict: "org_id,lease_id,period_start,period_end" })
      .select("*")
      .single();
    if (saveError) throw new Error(`Failed to persist percentage rent calculation: ${saveError.message}`);

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "percentage_rent_calculation",
      entityId: savedCalculation?.id ?? null,
      action: "PERCENTAGE_RENT_CALCULATED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      propertyId: lease.property_id ?? null,
      newValue: savedCalculation,
      source: "compute-percentage-rent",
    });

    return jsonResponse({ error: false, data: result, saved_calculation: savedCalculation });
  } catch (error) {
    const message = error?.message || "Could not compute percentage rent";
    console.error("[compute-percentage-rent]", message);
    return jsonResponse({ error: true, message, error_code: "COMPUTE_PERCENTAGE_RENT_FAILED" }, errorStatus(message));
  }
});
