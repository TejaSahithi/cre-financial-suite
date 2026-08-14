// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { resolveApprovedIndexAdjustment } from "../_shared/reference-data/approved-index-adjustment.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENT_REFERENCE_FIELD_KEYS = ["rent_escalation", "base_rent", "rent", "index_adjustment", "cpi"];

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

function asNumber(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function approvedRule(row: any) {
  const approval = String(row?.approval_status || "").toLowerCase();
  const review = String(row?.review_status || "").toLowerCase();
  return approval === "approved" || review === "approved";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["RentProjection", "LeaseReview", "LeaseExpenseRules"], "write");

    const body = await req.json().catch(() => ({}));
    const rentScheduleId = String(body.rent_schedule_id ?? body.rentScheduleId ?? "").trim();
    const ruleId = String(body.rule_id ?? body.ruleId ?? "").trim();
    if (!UUID_RE.test(rentScheduleId)) throw new Error("rent_schedule_id is required");
    if (!UUID_RE.test(ruleId)) throw new Error("rule_id is required");

    const { data: schedule, error: scheduleError } = await supabaseAdmin
      .from("rent_schedules")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", rentScheduleId)
      .eq("status", "approved")
      .maybeSingle();
    if (scheduleError) throw new Error(`Failed to load approved rent schedule: ${scheduleError.message}`);
    if (!schedule) throw new Error("Approved rent schedule not found");
    if (schedule.property_id) await assertPropertyAccess(req, schedule.property_id);

    const { data: rule, error: ruleError } = await supabaseAdmin
      .from("lease_expense_rules")
      .select("id,org_id,lease_id,property_id,approval_status,review_status,index_adjustment_applicable,index_adjustment_type,index_name,index_source,index_base_period,index_current_period,index_floor_percent,index_cap_percent,exact_source_text,notes")
      .eq("org_id", orgId)
      .eq("id", ruleId)
      .eq("lease_id", schedule.lease_id)
      .maybeSingle();
    if (ruleError) throw new Error(`Failed to load approved CPI rent rule: ${ruleError.message}`);
    if (!rule) throw new Error("CPI rent rule not found for this lease");
    if (!approvedRule(rule)) throw new Error("CPI rent rule must be approved before calculation");

    const baseMonthlyAmount = asNumber(schedule.monthly_amount) ?? (asNumber(schedule.annual_amount) != null ? asNumber(schedule.annual_amount) / 12 : null);
    const resolved = await resolveApprovedIndexAdjustment(supabaseAdmin, {
      orgId,
      leaseId: schedule.lease_id,
      rule,
      fieldKeys: RENT_REFERENCE_FIELD_KEYS,
      chargeType: "cpi_rent_adjustment",
      baseAmount: baseMonthlyAmount,
      periodStart: schedule.period_start,
      periodEnd: schedule.period_end,
      existingInputs: {
        sourceRentScheduleId: schedule.id,
        sourceRuleId: rule.id,
        baseRentSchedule: {
          periodStart: schedule.period_start,
          periodEnd: schedule.period_end,
          monthlyAmount: schedule.monthly_amount,
          annualAmount: schedule.annual_amount,
          approvedAt: schedule.approved_at,
          approvedBy: schedule.approved_by,
        },
      },
      existingEvidence: [{
        source_type: "rent_schedule",
        rent_schedule_id: schedule.id,
        status: schedule.status,
        approved_at: schedule.approved_at,
        approved_by: schedule.approved_by,
      }],
    });

    const result = resolved.result;
    const indexInputs = result?.inputs?.indexAdjustment || {};
    const proposalStatus = result?.status === "calculated" ? "pending_review" : "blocked";
    const proposedMonthly = result?.status === "calculated" ? result.amount : null;
    const row = {
      org_id: orgId,
      lease_id: schedule.lease_id,
      property_id: schedule.property_id || rule.property_id || null,
      source_rent_schedule_id: schedule.id,
      source_rule_id: rule.id,
      period_start: schedule.period_start,
      period_end: schedule.period_end,
      index_base_period: indexInputs.basePeriod || null,
      index_current_period: indexInputs.currentPeriod || null,
      base_monthly_amount: baseMonthlyAmount,
      proposed_monthly_amount: proposedMonthly,
      proposed_annual_amount: proposedMonthly == null ? null : Math.round((proposedMonthly * 12 + Number.EPSILON) * 100) / 100,
      status: proposalStatus,
      reason_codes: result?.reasonCodes || [],
      inputs: result?.inputs || {},
      evidence: result?.evidence || [],
      calculation_lines: result?.calculationLines || [],
      calculated_by: user.id,
    };

    const { data: saved, error: saveError } = await supabaseAdmin
      .from("cpi_rent_adjustment_proposals")
      .upsert(row, { onConflict: "org_id,lease_id,source_rent_schedule_id,source_rule_id,index_base_period,index_current_period" })
      .select("*")
      .maybeSingle();
    if (saveError) throw new Error(`Failed to save CPI rent adjustment proposal: ${saveError.message}`);

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "cpi_rent_adjustment_proposals",
      entityId: saved?.id,
      action: proposalStatus === "pending_review" ? "CPI_RENT_ADJUSTMENT_PROPOSED" : "CPI_RENT_ADJUSTMENT_BLOCKED",
      actorUserId: user.id,
      source: "compute-cpi-rent-adjustment",
      newValue: saved,
    });

    return jsonResponse({ error: false, data: saved });
  } catch (error) {
    const message = error?.message || "Could not compute CPI rent adjustment";
    console.error("[compute-cpi-rent-adjustment]", message);
    return jsonResponse({ error: true, message, error_code: "COMPUTE_CPI_RENT_ADJUSTMENT_FAILED" }, errorStatus(message));
  }
});

