// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 4B:
// extends cam-setup-actions-v2 to cover the complete CAM setup workflow.
//
// An authorized property manager can now complete the full CAM setup
// lifecycle without direct SQL or manual RPC calls. Every write goes
// through this dispatcher to a controlled backend command (RPC) with
// organization validation and audit evidence built in.
//
// Supported actions (workflow order):
//   PROPERTY / PERIOD
//     create_recovery_calendar    → create_recovery_calendar RPC
//     create_recovery_period      → create_recovery_period RPC
//
//   POOLS
//     create_recovery_pool        → create_recovery_pool RPC
//     assign_pool_category        → insert into recovery_pool_categories
//     remove_pool_category        → delete from recovery_pool_categories
//     assign_scope_member         → insert into recovery_pool_scope_members
//     configure_pool_grossup      → update recovery_pools.default_gross_up_target_pct
//
//   PARTICIPANTS
//     add_pool_participant        → add_recovery_pool_lease_participant RPC
//     remove_pool_participant     → remove_recovery_pool_lease_participant RPC
//
//   POLICIES
//     resolve_missing_policy_value → record_cam_prior_period_adjustment RPC
//
//   EXPENSES
//     assign_expense_to_pool      → assign_cam_input_to_pool RPC
//
//   ESTIMATES / ADJUSTMENTS
//     create_estimate_schedule    → upsert into cam_estimate_schedules
//     record_prior_adjustment     → record_cam_prior_period_adjustment RPC
//
// No action performs generic table CRUD. Every write is a controlled,
// audited command with org-scoped authorization.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ACTIONS = new Set([
  // Property / Period
  "create_recovery_calendar",
  "create_recovery_period",
  // Pools
  "create_recovery_pool",
  "assign_pool_category",
  "remove_pool_category",
  "assign_scope_member",
  "configure_pool_grossup",
  // Participants
  "add_pool_participant",
  "remove_pool_participant",
  // Policies
  "resolve_missing_policy_value",
  // Expenses
  "assign_expense_to_pool",
  // Estimates / Adjustments
  "create_estimate_schedule",
  "record_prior_adjustment",
]);

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|action must be/i.test(message)) return 400;
  return 500;
}

function requireUUID(value: unknown, fieldName: string): string {
  const s = String(value ?? "").trim();
  if (!UUID_RE.test(s)) throw new Error(`${fieldName} is required and must be a valid UUID`);
  return s;
}

function requireString(value: unknown, fieldName: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${fieldName} is required`);
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMSetupV2"], "write");

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "").trim().toLowerCase();
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`action must be one of: ${[...VALID_ACTIONS].join(", ")}`);
    }

    const actorArgs = {
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_actor_email: user.email ?? "unknown@example.com",
    };

    // Helper: assert the caller has property-level access before writing.
    async function guardProperty(propertyId: string) {
      await assertPropertyAccess(req, propertyId);
    }

    let result: Record<string, unknown>;

    // ---- PROPERTY / PERIOD --------------------------------------------------

    if (action === "create_recovery_calendar") {
      const propertyId = requireUUID(body?.property_id, "property_id");
      const name = requireString(body?.name, "name");
      const calendarType = requireString(body?.calendar_type, "calendar_type");
      const fiscalStartMonth = Number(body?.fiscal_start_month ?? 1);
      await guardProperty(propertyId);

      const { data, error } = await supabaseAdmin.rpc("create_recovery_calendar", {
        ...actorArgs,
        p_property_id: propertyId,
        p_name: name,
        p_calendar_type: calendarType,
        p_fiscal_start_month: fiscalStartMonth,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else if (action === "create_recovery_period") {
      const calendarId = requireUUID(body?.calendar_id, "calendar_id");
      const startDate = requireString(body?.start_date, "start_date");
      const endDate = requireString(body?.end_date, "end_date");
      const label = requireString(body?.label, "label");

      const { data, error } = await supabaseAdmin.rpc("create_recovery_period", {
        ...actorArgs,
        p_calendar_id: calendarId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_label: label,
      });
      if (error) throw new Error(error.message);
      result = data;

    // ---- POOLS --------------------------------------------------------------

    } else if (action === "create_recovery_pool") {
      const propertyId = requireUUID(body?.property_id, "property_id");
      const periodId = requireUUID(body?.period_id, "period_id");
      const name = requireString(body?.name, "name");
      const poolType = requireString(body?.pool_type, "pool_type");
      const scopeType = requireString(body?.scope_type, "scope_type");
      const scopeId = body?.scope_id ? requireUUID(body.scope_id, "scope_id") : propertyId;
      await guardProperty(propertyId);

      const { data, error } = await supabaseAdmin.rpc("create_recovery_pool", {
        ...actorArgs,
        p_property_id: propertyId,
        p_period_id: periodId,
        p_name: name,
        p_pool_type: poolType,
        p_scope_type: scopeType,
        p_scope_id: scopeId,
        p_is_template: false,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else if (action === "assign_pool_category") {
      const poolId = requireUUID(body?.pool_id, "pool_id");
      const expenseCategoryId = requireUUID(body?.expense_category_id, "expense_category_id");
      const inclusionMode = String(body?.inclusion_mode ?? "include").trim();
      const variabilityDefault = String(body?.variability_default ?? "variable").trim();
      const controllabilityDefault = String(body?.controllability_default ?? "controllable").trim();

      // Verify the pool belongs to this org.
      const { data: poolRow, error: poolError } = await supabaseAdmin
        .from("recovery_pools").select("property_id").eq("id", poolId).eq("org_id", orgId).maybeSingle();
      if (poolError) throw new Error(poolError.message);
      if (!poolRow) throw new Error("Pool not found for this organization");
      await guardProperty(poolRow.property_id);

      const { data, error } = await supabaseAdmin
        .from("recovery_pool_categories")
        .upsert(
          { org_id: orgId, pool_id: poolId, expense_category_id: expenseCategoryId, inclusion_mode: inclusionMode, variability_default: variabilityDefault, controllability_default: controllabilityDefault },
          { onConflict: "pool_id,expense_category_id" },
        )
        .select("*").single();
      if (error) throw new Error(error.message);
      result = { category_assignment: data };

    } else if (action === "remove_pool_category") {
      const poolId = requireUUID(body?.pool_id, "pool_id");
      const expenseCategoryId = requireUUID(body?.expense_category_id, "expense_category_id");

      const { data: poolRow, error: poolError } = await supabaseAdmin
        .from("recovery_pools").select("property_id").eq("id", poolId).eq("org_id", orgId).maybeSingle();
      if (poolError) throw new Error(poolError.message);
      if (!poolRow) throw new Error("Pool not found for this organization");
      await guardProperty(poolRow.property_id);

      const { error } = await supabaseAdmin
        .from("recovery_pool_categories")
        .delete()
        .eq("pool_id", poolId)
        .eq("expense_category_id", expenseCategoryId)
        .eq("org_id", orgId);
      if (error) throw new Error(error.message);
      result = { removed: true, pool_id: poolId, expense_category_id: expenseCategoryId };

    } else if (action === "assign_scope_member") {
      const poolId = requireUUID(body?.pool_id, "pool_id");
      const scopeId = requireUUID(body?.scope_id, "scope_id");
      const scopeType = requireString(body?.scope_type, "scope_type");
      const effectiveFrom = requireString(body?.effective_from, "effective_from");
      const includeInDenominator = body?.include_in_denominator !== false;

      const { data: poolRow, error: poolError } = await supabaseAdmin
        .from("recovery_pools").select("property_id").eq("id", poolId).eq("org_id", orgId).maybeSingle();
      if (poolError) throw new Error(poolError.message);
      if (!poolRow) throw new Error("Pool not found for this organization");
      await guardProperty(poolRow.property_id);

      const { data, error } = await supabaseAdmin
        .from("recovery_pool_scope_members")
        .upsert(
          { org_id: orgId, pool_id: poolId, scope_type: scopeType, scope_id: scopeId, effective_from: effectiveFrom, effective_to: body?.effective_to ?? null, include_in_denominator: includeInDenominator },
          { onConflict: "pool_id,scope_id" },
        )
        .select("*").single();
      if (error) throw new Error(error.message);
      result = { scope_member: data };

    } else if (action === "configure_pool_grossup") {
      const poolId = requireUUID(body?.pool_id, "pool_id");
      const targetPct = body?.default_gross_up_target_pct === null ? null : Number(body?.default_gross_up_target_pct);

      const { data: poolRow, error: poolError } = await supabaseAdmin
        .from("recovery_pools").select("property_id").eq("id", poolId).eq("org_id", orgId).maybeSingle();
      if (poolError) throw new Error(poolError.message);
      if (!poolRow) throw new Error("Pool not found for this organization");
      await guardProperty(poolRow.property_id);

      const { data, error } = await supabaseAdmin
        .from("recovery_pools")
        .update({ default_gross_up_target_pct: targetPct, updated_at: new Date().toISOString() })
        .eq("id", poolId)
        .eq("org_id", orgId)
        .select("id, default_gross_up_target_pct").single();
      if (error) throw new Error(error.message);
      result = { pool_grossup: data };

    // ---- PARTICIPANTS -------------------------------------------------------

    } else if (action === "add_pool_participant") {
      const poolId = requireUUID(body?.pool_id, "pool_id");
      const leaseId = requireUUID(body?.lease_id, "lease_id");
      const effectiveFrom = requireString(body?.effective_from, "effective_from");

      const { data: leaseRow, error: leaseError } = await supabaseAdmin
        .from("leases").select("property_id").eq("id", leaseId).eq("org_id", orgId).maybeSingle();
      if (leaseError) throw new Error(leaseError.message);
      if (!leaseRow) throw new Error("Lease not found for this organization");
      await guardProperty(leaseRow.property_id);

      const { data, error } = await supabaseAdmin.rpc("add_recovery_pool_lease_participant", {
        ...actorArgs, p_pool_id: poolId, p_lease_id: leaseId, p_effective_from: effectiveFrom,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else if (action === "remove_pool_participant") {
      const participantId = requireUUID(body?.participant_id, "participant_id");

      const { data: participantRow, error: participantError } = await supabaseAdmin
        .from("recovery_pool_lease_participants")
        .select("pool_id, lease_id")
        .eq("id", participantId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (participantError) throw new Error(participantError.message);
      if (!participantRow) throw new Error("Participant not found for this organization");

      const { error } = await supabaseAdmin
        .from("recovery_pool_lease_participants")
        .update({ status: "removed", updated_at: new Date().toISOString() })
        .eq("id", participantId)
        .eq("org_id", orgId);
      if (error) throw new Error(error.message);
      result = { removed: true, participant_id: participantId };

    // ---- POLICIES -----------------------------------------------------------

    } else if (action === "resolve_missing_policy_value") {
      // Resolve a MISSING or UNKNOWN policy value (e.g. an unknown prior
      // adjustment). Proxies to record_cam_prior_period_adjustment or a
      // direct policy value upsert depending on the resolution_type field.
      const leaseId = requireUUID(body?.lease_id, "lease_id");
      const recoveryPeriodId = requireUUID(body?.recovery_period_id, "recovery_period_id");
      const adjustmentType = requireString(body?.adjustment_type, "adjustment_type");
      const state = requireString(body?.state, "state");
      const amount = ["KNOWN_AMOUNT"].includes(state) ? Number(body?.amount ?? 0) : null;
      const evidenceNote = String(body?.evidence_note ?? "").trim() || null;

      const { data: leaseRow, error: leaseError } = await supabaseAdmin
        .from("leases").select("property_id").eq("id", leaseId).eq("org_id", orgId).maybeSingle();
      if (leaseError) throw new Error(leaseError.message);
      if (!leaseRow) throw new Error("Lease not found for this organization");
      await guardProperty(leaseRow.property_id);

      const { data, error } = await supabaseAdmin.rpc("record_cam_prior_period_adjustment", {
        ...actorArgs,
        p_lease_id: leaseId,
        p_recovery_period_id: recoveryPeriodId,
        p_adjustment_type: adjustmentType,
        p_state: state,
        p_amount: amount,
        p_evidence_note: evidenceNote,
      });
      if (error) throw new Error(error.message);
      result = data;

    // ---- EXPENSES -----------------------------------------------------------

    } else if (action === "assign_expense_to_pool") {
      const camExpenseInputId = requireUUID(body?.cam_expense_input_id, "cam_expense_input_id");
      const recoveryPoolId = requireUUID(body?.recovery_pool_id, "recovery_pool_id");
      const amount = Number(body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount is required and must be positive");

      const { data: expenseRow, error: expenseError } = await supabaseAdmin
        .from("cam_expense_inputs").select("property_id").eq("id", camExpenseInputId).eq("org_id", orgId).maybeSingle();
      if (expenseError) throw new Error(expenseError.message);
      if (!expenseRow) throw new Error("Expense input not found for this organization");
      await guardProperty(expenseRow.property_id);

      const { data, error } = await supabaseAdmin.rpc("assign_cam_input_to_pool", {
        ...actorArgs,
        p_cam_expense_input_id: camExpenseInputId,
        p_recovery_pool_id: recoveryPoolId,
        p_amount: amount,
        p_assignment_method: "manual",
      });
      if (error) throw new Error(error.message);
      result = data;

    // ---- ESTIMATES / ADJUSTMENTS --------------------------------------------

    } else if (action === "create_estimate_schedule") {
      const leaseId = requireUUID(body?.lease_id, "lease_id");
      const recoveryPeriodId = requireUUID(body?.recovery_period_id, "recovery_period_id");
      const monthDate = requireString(body?.month_date, "month_date");
      const amount = Number(body?.amount ?? 0);
      const source = String(body?.source ?? "manual").trim();

      const { data: leaseRow, error: leaseError } = await supabaseAdmin
        .from("leases").select("property_id").eq("id", leaseId).eq("org_id", orgId).maybeSingle();
      if (leaseError) throw new Error(leaseError.message);
      if (!leaseRow) throw new Error("Lease not found for this organization");
      await guardProperty(leaseRow.property_id);

      const { data, error } = await supabaseAdmin
        .from("cam_estimate_schedules")
        .upsert(
          { org_id: orgId, lease_id: leaseId, recovery_period_id: recoveryPeriodId, month_date: monthDate, amount, source, status: "scheduled" },
          { onConflict: "org_id,lease_id,recovery_period_id,month_date" },
        )
        .select("*").single();
      if (error) throw new Error(error.message);
      result = { estimate_schedule: data };

    } else if (action === "record_prior_adjustment") {
      const leaseId = requireUUID(body?.lease_id, "lease_id");
      const recoveryPeriodId = requireUUID(body?.recovery_period_id, "recovery_period_id");
      const adjustmentType = requireString(body?.adjustment_type, "adjustment_type");
      const state = requireString(body?.state, "state");
      const amount = ["KNOWN_AMOUNT"].includes(state) ? Number(body?.amount ?? 0) : null;

      const { data: leaseRow, error: leaseError } = await supabaseAdmin
        .from("leases").select("property_id").eq("id", leaseId).eq("org_id", orgId).maybeSingle();
      if (leaseError) throw new Error(leaseError.message);
      if (!leaseRow) throw new Error("Lease not found for this organization");
      await guardProperty(leaseRow.property_id);

      const { data, error } = await supabaseAdmin.rpc("record_cam_prior_period_adjustment", {
        ...actorArgs,
        p_lease_id: leaseId,
        p_recovery_period_id: recoveryPeriodId,
        p_adjustment_type: adjustmentType,
        p_state: state,
        p_amount: amount,
        p_evidence_note: String(body?.evidence_note ?? "").trim() || null,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else {
      // Unreachable due to VALID_ACTIONS guard above, but makes TypeScript happy.
      throw new Error(`Unhandled action: ${action}`);
    }

    return jsonResponse({ action, ...result }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, errorStatus(message));
  }
});
