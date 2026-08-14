// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";
import { calculateAdditionalRentReconciliation, deterministicChargeKey } from "../_shared/additional-rent-reconciliation/additional-rent-reconciliation.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUTHORITATIVE_STATUSES = ["approved", "active", "posted"];
const READ_MODEL_STATUSES = ["draft", "pending_review", "calculated", "blocked", "approved", "active", "posted"];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function errorStatus(message) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/not found/i.test(message)) return 404;
  if (/required|invalid|cannot|transition|blocked|posted/i.test(message)) return 400;
  return 500;
}

function requireUuid(value, label) {
  const id = String(value || "").trim();
  if (!UUID_RE.test(id)) throw new Error(`${label} is required`);
  return id;
}

function requireDate(value, label) {
  const date = String(value || "").slice(0, 10);
  if (!DATE_RE.test(date)) throw new Error(`${label} is required in YYYY-MM-DD format`);
  return date;
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function round2(value) {
  const amount = Number(value || 0);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function overlaps(rowStart, rowEnd, periodStart, periodEnd) {
  const start = String(rowStart || "0001-01-01").slice(0, 10);
  const end = String(rowEnd || "9999-12-31").slice(0, 10);
  return start <= periodEnd && end >= periodStart;
}

function fiscalYear(periodStart) {
  return Number(String(periodStart).slice(0, 4));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadLease(ctx, leaseId) {
  const { data, error } = await ctx.supabaseAdmin
    .from("leases")
    .select("id, org_id, property_id, tenant_name")
    .eq("org_id", ctx.orgId)
    .eq("id", leaseId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load lease: ${error.message}`);
  if (!data?.id) throw new Error("Lease not found");
  if (data.property_id) await assertPropertyAccess(ctx.req, data.property_id);
  return data;
}

async function loadLatestCamLines(ctx, leaseId, periodStart, periodEnd) {
  const { data: resultRows, error: resultError } = await ctx.supabaseAdmin
    .from("cam_run_lease_results")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("lease_id", leaseId)
    .in("status", ["reviewed", "posted"])
    .limit(100);
  if (resultError) throw new Error(`Failed to load CAM lease results: ${resultError.message}`);
  if (!Array.isArray(resultRows) || resultRows.length === 0) return [];

  const runIds = [...new Set(resultRows.map((row) => row.cam_run_id).filter(Boolean))];
  const { data: runRows, error: runError } = await ctx.supabaseAdmin
    .from("cam_runs")
    .select("id, org_id, recovery_period_id, status, run_type, input_hash, engine_version, approved_by, approved_at, posted_at, created_at, updated_at")
    .eq("org_id", ctx.orgId)
    .in("id", runIds)
    .in("status", ["approved", "posted"]);
  if (runError) throw new Error(`Failed to load CAM runs: ${runError.message}`);
  if (!Array.isArray(runRows) || runRows.length === 0) return [];

  const periodIds = [...new Set(runRows.map((row) => row.recovery_period_id).filter(Boolean))];
  const { data: periods, error: periodError } = await ctx.supabaseAdmin
    .from("recovery_periods")
    .select("id, start_date, end_date, label")
    .eq("org_id", ctx.orgId)
    .in("id", periodIds);
  if (periodError) throw new Error(`Failed to load recovery periods: ${periodError.message}`);

  const periodById = new Map((periods || []).map((row) => [row.id, row]));
  const runById = new Map(runRows.map((row) => [row.id, row]));
  const candidates = resultRows
    .map((result) => ({ result, run: runById.get(result.cam_run_id), period: periodById.get(runById.get(result.cam_run_id)?.recovery_period_id) }))
    .filter(({ run, period }) => run?.id && period?.id && overlaps(period.start_date, period.end_date, periodStart, periodEnd))
    .sort((a, b) => String(b.run.posted_at || b.run.approved_at || b.run.updated_at || b.run.created_at || "").localeCompare(String(a.run.posted_at || a.run.approved_at || a.run.updated_at || a.run.created_at || "")));

  const chosen = candidates[0];
  if (!chosen) return [];
  const sourcePeriod = `${chosen.period.start_date}:${chosen.period.end_date}`;
  const actual = {
    role: "actual",
    charge_type: "cam",
    authoritative_table: "cam_run_lease_results",
    source_record_id: chosen.result.id,
    source_period: sourcePeriod,
    period_start: chosen.period.start_date,
    period_end: chosen.period.end_date,
    amount: round2(chosen.result.final_recovery),
    currency: "USD",
    status: chosen.run.status,
    explanation: "CAM V2 final tenant recovery from approved/posted CAM run.",
    evidence: { cam_run_id: chosen.run.id, recovery_period_id: chosen.period.id, input_hash: chosen.run.input_hash, engine_version: chosen.run.engine_version },
    source_snapshot: { cam_run: chosen.run, cam_run_lease_result: chosen.result, recovery_period: chosen.period },
  };
  const billed = {
    role: "billed",
    charge_type: "cam",
    authoritative_table: "cam_run_lease_results",
    source_record_id: chosen.result.id,
    source_period: sourcePeriod,
    period_start: chosen.period.start_date,
    period_end: chosen.period.end_date,
    amount: round2(chosen.result.estimates_billed),
    currency: "USD",
    status: chosen.run.status,
    explanation: "CAM V2 estimates billed for this tenant and recovery period.",
    evidence: { cam_run_id: chosen.run.id, recovery_period_id: chosen.period.id, input_hash: chosen.run.input_hash, engine_version: chosen.run.engine_version },
    source_snapshot: { cam_run: chosen.run, cam_run_lease_result: chosen.result, recovery_period: chosen.period },
  };
  actual.charge_key = deterministicChargeKey(actual);
  billed.charge_key = deterministicChargeKey(billed);
  return [actual, billed];
}

async function loadLeaseChargeLines(ctx, leaseId, periodStart, periodEnd) {
  const { data, error } = await ctx.supabaseAdmin
    .from("lease_charge_read_model")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("lease_id", leaseId)
    .lte("period_start", periodEnd)
    .gte("period_end", periodStart)
    .in("status", READ_MODEL_STATUSES)
    .limit(100);
  if (error) throw new Error(`Failed to load lease charge read model: ${error.message}`);

  return (data || [])
    .filter((row) => ["management_fee", "percentage_rent"].includes(String(row.charge_type || "").toLowerCase()))
    .map((row) => {
      const line = {
        role: "actual",
        charge_type: row.charge_type,
        authoritative_table: row.authoritative_table,
        source_record_id: row.source_record_id,
        source_period: `${row.period_start}:${row.period_end}`,
        period_start: row.period_start,
        period_end: row.period_end,
        amount: round2(row.amount),
        currency: row.currency || "USD",
        status: row.status,
        explanation: `${row.charge_type} from lease_charge_read_model; reconciliation consumes, not recalculates, this source.`,
        evidence: { reason_codes: row.reason_codes || [], source_metadata: row.source_metadata || {}, evidence: row.evidence || [] },
        source_snapshot: row,
      };
      line.charge_key = deterministicChargeKey(line);
      return line;
    });
}

function normalizeExternalLines(lines, role) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const normalized = {
      ...line,
      role,
      charge_type: line.charge_type,
      authoritative_table: line.authoritative_table,
      source_record_id: line.source_record_id,
      source_period: line.source_period || `${line.period_start || "unknown"}:${line.period_end || "unknown"}`,
      amount: round2(line.amount),
      status: line.status || "approved",
      evidence: line.evidence || {},
      source_snapshot: line.source_snapshot || line,
    };
    normalized.charge_key = line.charge_key || deterministicChargeKey(normalized);
    return normalized;
  });
}

async function insertReconciliation(ctx, lease, body, calculation, sourceHash, version, supersedesId) {
  const header = {
    org_id: ctx.orgId,
    property_id: lease.property_id || body.property_id || body.propertyId || null,
    lease_id: lease.id,
    fiscal_year: Number(body.fiscal_year || body.fiscalYear || fiscalYear(body.period_start ?? body.periodStart)),
    period_start: requireDate(body.period_start ?? body.periodStart, "period_start"),
    period_end: requireDate(body.period_end ?? body.periodEnd, "period_end"),
    version,
    supersedes_reconciliation_id: supersedesId || null,
    status: calculation.status,
    actual_responsibility: calculation.totals.actual_responsibility,
    billed_amount: calculation.totals.billed_amount,
    adjustments_amount: calculation.totals.adjustments_amount,
    credits_amount: calculation.totals.credits_amount,
    final_balance: calculation.final_balance,
    balance_disposition: calculation.balance_disposition,
    currency: "USD",
    reason_codes: calculation.reason_codes,
    source_hash: sourceHash,
    engine_version: calculation.engine_version,
    calculation_lines: calculation.calculation_lines,
    input_snapshot: calculation.input_snapshot,
    created_by: ctx.user.id,
    calculated_by: ctx.user.id,
  };
  const { data: saved, error } = await ctx.supabaseAdmin
    .from("tenant_reconciliations")
    .insert(header)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save tenant reconciliation: ${error.message}`);

  const lines = (calculation.input_snapshot.lines || []).map((line) => ({
    org_id: ctx.orgId,
    tenant_reconciliation_id: saved.id,
    property_id: header.property_id,
    lease_id: lease.id,
    line_role: line.role,
    charge_type: line.charge_type,
    authoritative_table: line.authoritative_table,
    source_record_id: line.source_record_id,
    source_period: line.source_period,
    charge_key: line.charge_key,
    period_start: line.period_start,
    period_end: line.period_end,
    amount: line.amount,
    currency: line.currency || "USD",
    source_status: line.status,
    explanation: line.explanation,
    evidence: line.evidence || {},
    source_snapshot: line.source_snapshot || {},
  }));
  if (lines.length) {
    const { error: lineError } = await ctx.supabaseAdmin.from("tenant_reconciliation_lines").insert(lines);
    if (lineError) throw new Error(`Failed to save tenant reconciliation lines: ${lineError.message}`);
  }

  await writeOperationalAudit(ctx.supabaseAdmin, {
    orgId: ctx.orgId,
    entityType: "tenant_reconciliation",
    entityId: saved.id,
    action: "TENANT_RECONCILIATION_CALCULATED",
    actorEmail: ctx.user.email || null,
    actorUserId: ctx.user.id,
    propertyId: header.property_id,
    newValue: { reconciliation: saved, line_count: lines.length },
    source: "tenant-reconciliation-command",
  });
  return saved;
}

async function calculateCommand(ctx, body) {
  await assertPageAccess(ctx.req, ctx.orgId, ["Reconciliation", "AutomationReadiness"], "write");
  const leaseId = requireUuid(body.lease_id ?? body.leaseId, "lease_id");
  const periodStart = requireDate(body.period_start ?? body.periodStart, "period_start");
  const periodEnd = requireDate(body.period_end ?? body.periodEnd, "period_end");
  const lease = await loadLease(ctx, leaseId);

  const authoritativeLines = [
    ...(await loadLatestCamLines(ctx, leaseId, periodStart, periodEnd)),
    ...(await loadLeaseChargeLines(ctx, leaseId, periodStart, periodEnd)),
    ...normalizeExternalLines(body.adjustment_lines ?? body.adjustmentLines, "adjustment"),
    ...normalizeExternalLines(body.credit_lines ?? body.creditLines, "credit"),
    ...normalizeExternalLines(body.billed_lines ?? body.billedLines, "billed"),
  ];

  const calculation = calculateAdditionalRentReconciliation({ period_start: periodStart, period_end: periodEnd, lines: authoritativeLines });
  const sourceHash = await sha256Json({ lease_id: leaseId, period_start: periodStart, period_end: periodEnd, lines: calculation.input_snapshot.lines });

  const { data: existingRows, error: existingError } = await ctx.supabaseAdmin
    .from("tenant_reconciliations")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("lease_id", leaseId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .eq("source_hash", sourceHash)
    .neq("status", "superseded")
    .order("version", { ascending: false })
    .limit(1);
  if (existingError) throw new Error(`Failed idempotency check: ${existingError.message}`);
  if (existingRows?.[0]) return { reconciliation: existingRows[0], idempotent: true };

  const { data: latestRows, error: latestError } = await ctx.supabaseAdmin
    .from("tenant_reconciliations")
    .select("id, version, status")
    .eq("org_id", ctx.orgId)
    .eq("lease_id", leaseId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .order("version", { ascending: false })
    .limit(1);
  if (latestError) throw new Error(`Failed version lookup: ${latestError.message}`);
  const latest = latestRows?.[0] || null;
  const nextVersion = latest ? Number(latest.version || 1) + 1 : 1;
  const saved = await insertReconciliation(ctx, lease, { ...body, period_start: periodStart, period_end: periodEnd }, calculation, sourceHash, nextVersion, latest?.id || null);
  return { reconciliation: saved, lines: calculation.input_snapshot.lines, idempotent: false };
}

async function loadReconciliation(ctx, id) {
  const { data, error } = await ctx.supabaseAdmin
    .from("tenant_reconciliations")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load tenant reconciliation: ${error.message}`);
  if (!data?.id) throw new Error("Tenant reconciliation not found");
  if (data.property_id) await assertPropertyAccess(ctx.req, data.property_id);
  return data;
}

function assertTransition(row, allowed, command) {
  const status = String(row.status || "").toLowerCase();
  if (!allowed.includes(status)) throw new Error(`${command} cannot run from status ${status || "empty"}`);
}

async function transitionCommand(ctx, command, body) {
  await assertPageAccess(ctx.req, ctx.orgId, ["Reconciliation", "AutomationReadiness"], "write");
  const id = requireUuid(body.reconciliation_id ?? body.reconciliationId, "reconciliation_id");
  const current = await loadReconciliation(ctx, id);
  const now = new Date().toISOString();
  let patch;
  let action;
  let reason = body.reason ? String(body.reason) : null;

  if (command === "submitReconciliation") {
    assertTransition(current, ["calculated"], command);
    if (Array.isArray(current.reason_codes) && current.reason_codes.length) throw new Error("Blocked reconciliation cannot be submitted");
    patch = { status: "pending_review", submitted_at: now, submitted_by: ctx.user.id };
    action = "TENANT_RECONCILIATION_SUBMITTED";
  } else if (command === "approveReconciliation") {
    assertTransition(current, ["pending_review"], command);
    if (Array.isArray(current.reason_codes) && current.reason_codes.length) throw new Error("Blocked reconciliation cannot be approved");
    patch = { status: "approved", approved_at: now, approved_by: ctx.user.id, review_reason: reason };
    action = "TENANT_RECONCILIATION_APPROVED";
  } else if (command === "rejectReconciliation") {
    reason = requireText(body.reason, "reason");
    assertTransition(current, ["pending_review", "calculated", "blocked"], command);
    patch = { status: "rejected", rejected_at: now, rejected_by: ctx.user.id, review_reason: reason };
    action = "TENANT_RECONCILIATION_REJECTED";
  } else if (command === "postReconciliation") {
    assertTransition(current, ["approved"], command);
    if (Array.isArray(current.reason_codes) && current.reason_codes.length) throw new Error("Blocked reconciliation cannot be posted");
    patch = { status: "posted", posted_at: now, posted_by: ctx.user.id };
    action = "TENANT_RECONCILIATION_POSTED";
  } else {
    throw new Error(`Unsupported tenant reconciliation command ${command}`);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("tenant_reconciliations")
    .update(patch)
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`${command} failed: ${error.message}`);
  await writeOperationalAudit(ctx.supabaseAdmin, {
    orgId: ctx.orgId,
    entityType: "tenant_reconciliation",
    entityId: id,
    action,
    actorEmail: ctx.user.email || null,
    actorUserId: ctx.user.id,
    propertyId: data.property_id || null,
    oldValue: current,
    newValue: data,
    reason,
    source: "tenant-reconciliation-command",
  });
  return { reconciliation: data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const body = await req.json().catch(() => ({}));
    const command = requireText(body.command, "command");
    const ctx = { req, supabaseAdmin, user, orgId };
    const data = command === "calculateReconciliation"
      ? await calculateCommand(ctx, body)
      : await transitionCommand(ctx, command, body);
    return jsonResponse({ error: false, command, data });
  } catch (error) {
    const message = error?.message || "Tenant reconciliation command failed";
    console.error("[tenant-reconciliation-command]", message);
    return jsonResponse({ error: true, message, error_code: "TENANT_RECONCILIATION_COMMAND_FAILED" }, errorStatus(message));
  }
});

