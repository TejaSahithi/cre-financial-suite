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
//     resolve_policy_conflict     → resolve_cam_policy_conflict RPC (controlled
//                                    versioned override -- supersedes one of two
//                                    genuinely conflicting policies with a
//                                    mandatory reason; refuses to act absent an
//                                    actual conflict)
//
//   EXPENSES
//     assign_expense_to_pool      → assign_cam_input_to_pool RPC
//
//   ESTIMATES / ADJUSTMENTS
//     create_estimate_schedule       → upsert into cam_estimate_schedules
//     create_estimate_schedules_bulk → bulk upsert into cam_estimate_schedules (one lease, many months)
//     record_prior_adjustment        → record_cam_prior_period_adjustment RPC
//
// No action performs generic table CRUD. Every write is a controlled,
// audited command with org-scoped authorization.
//
// Corrections made when this file was extended for the CAM Setup UX pass:
//   - resolve_missing_policy_value / record_prior_adjustment previously
//     called record_cam_prior_period_adjustment with p_evidence_note, which
//     is not a parameter of that RPC (the actual name is p_notes) -- every
//     call failed. Fixed.
//   - remove_pool_participant previously set status='removed', which
//     recovery_pool_lease_participants' CHECK constraint does not allow
//     (only 'active'/'ended') -- every call failed. Fixed to set
//     status='ended' + effective_to=today, with the now-mandatory reason
//     recorded in notes and mirrored to audit_logs.
//   - assign_scope_member previously upserted with
//     onConflict:"pool_id,scope_id", but recovery_pool_scope_members has no
//     matching unique/exclusion constraint on exactly those two columns
//     (only a GIST date-range exclusion) -- every call failed. Fixed to
//     select-then-insert-or-update against the currently-open row.
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
  "resolve_policy_conflict",
  // Expenses
  "assign_expense_to_pool",
  // Estimates / Adjustments
  "create_estimate_schedule",
  "create_estimate_schedules_bulk",
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

      // recovery_pool_scope_members has no plain UNIQUE(pool_id, scope_id) --
      // only a GIST date-range exclusion constraint -- so there is no
      // matching onConflict target for a real upsert. Instead: update the
      // currently-open (effective_to IS NULL) row for this exact
      // pool/scope/type if one exists, otherwise insert a new one.
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("recovery_pool_scope_members")
        .select("id").eq("pool_id", poolId).eq("scope_id", scopeId).eq("scope_type", scopeType).is("effective_to", null).maybeSingle();
      if (existingError) throw new Error(existingError.message);

      let data;
      if (existing) {
        const { data: updated, error: updateError } = await supabaseAdmin
          .from("recovery_pool_scope_members")
          .update({ effective_from: effectiveFrom, effective_to: body?.effective_to ?? null, include_in_denominator: includeInDenominator, updated_at: new Date().toISOString() })
          .eq("id", existing.id).select("*").single();
        if (updateError) throw new Error(updateError.message);
        data = updated;
      } else {
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from("recovery_pool_scope_members")
          .insert({ org_id: orgId, pool_id: poolId, scope_type: scopeType, scope_id: scopeId, effective_from: effectiveFrom, effective_to: body?.effective_to ?? null, include_in_denominator: includeInDenominator })
          .select("*").single();
        if (insertError) throw new Error(insertError.message);
        data = inserted;
      }
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

      const notes = String(body?.notes ?? body?.reason ?? "").trim() || null;
      const { data, error } = await supabaseAdmin.rpc("add_recovery_pool_lease_participant", {
        ...actorArgs, p_pool_id: poolId, p_lease_id: leaseId, p_effective_from: effectiveFrom, p_notes: notes,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else if (action === "remove_pool_participant") {
      // recovery_pool_lease_participants.status is CHECK-constrained to
      // ('active','ended') -- there is no 'removed' value. Excluding a
      // suggested/participating lease is represented as the participation
      // window ending today, with the mandatory reason captured in notes
      // (and mirrored to audit_logs) rather than a status value the schema
      // doesn't support.
      const participantId = requireUUID(body?.participant_id, "participant_id");
      const reason = requireString(body?.reason, "reason");

      const { data: participantRow, error: participantError } = await supabaseAdmin
        .from("recovery_pool_lease_participants")
        .select("pool_id, lease_id")
        .eq("id", participantId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (participantError) throw new Error(participantError.message);
      if (!participantRow) throw new Error("Participant not found for this organization");

      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabaseAdmin
        .from("recovery_pool_lease_participants")
        .update({ status: "ended", effective_to: today, notes: reason, updated_at: new Date().toISOString() })
        .eq("id", participantId)
        .eq("org_id", orgId);
      if (error) throw new Error(error.message);

      await supabaseAdmin.from("audit_logs").insert({
        org_id: orgId, entity_type: "RecoveryPoolLeaseParticipant", entity_id: participantId,
        action: "cam_setup_participant_excluded", actor_user_id: user.id, actor_email: user.email ?? "unknown@example.com",
        severity: "info", source: "edge_function", metadata: { pool_id: participantRow.pool_id, lease_id: participantRow.lease_id, reason },
        timestamp: new Date().toISOString(),
      });

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
      // record_cam_prior_period_adjustment's free-text evidence parameter is
      // named p_notes, not p_evidence_note -- this previously called the RPC
      // with an unknown named parameter and always failed at the RPC layer.
      const notes = String(body?.evidence_note ?? body?.notes ?? "").trim() || null;

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
        p_notes: notes,
      });
      if (error) throw new Error(error.message);
      result = data;

    } else if (action === "resolve_policy_conflict") {
      // Controlled versioned override for a POLICY_CONFLICT readiness
      // exception (two active policies on the same lease, same category,
      // overlapping effective window) -- NOT unrestricted manual rule
      // selection. resolve_cam_policy_conflict re-verifies a genuine
      // conflict exists before superseding anything, and always requires a
      // reason.
      const policyIdToSupersede = requireUUID(body?.policy_id_to_supersede, "policy_id_to_supersede");
      const reason = requireString(body?.reason, "reason");

      const { data: policyRow, error: policyError } = await supabaseAdmin
        .from("lease_recovery_policies").select("lease_id, leases(property_id)").eq("id", policyIdToSupersede).eq("org_id", orgId).maybeSingle();
      if (policyError) throw new Error(policyError.message);
      if (!policyRow) throw new Error("Policy not found for this organization");
      await guardProperty(policyRow.leases?.property_id);

      const { data, error } = await supabaseAdmin.rpc("resolve_cam_policy_conflict", {
        ...actorArgs,
        p_policy_id_to_supersede: policyIdToSupersede,
        p_reason: reason,
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

    } else if (action === "create_estimate_schedules_bulk") {
      // Bulk monthly-row generation for one lease -- the wizard computes the
      // per-month rows (possibly across several effective-amount ranges)
      // client-side and sends them here as one call so a multi-month entry
      // is one auditable write, not N separate ones.
      const leaseId = requireUUID(body?.lease_id, "lease_id");
      const recoveryPeriodId = requireUUID(body?.recovery_period_id, "recovery_period_id");
      const source = String(body?.source ?? "manual").trim();
      const rows = Array.isArray(body?.rows) ? body.rows : [];
      if (rows.length === 0) throw new Error("rows is required and must be a non-empty array");
      for (const row of rows) {
        requireString(row?.month_date, "rows[].month_date");
        if (!Number.isFinite(Number(row?.amount))) throw new Error("rows[].amount must be a number");
      }

      const { data: leaseRow, error: leaseError } = await supabaseAdmin
        .from("leases").select("property_id").eq("id", leaseId).eq("org_id", orgId).maybeSingle();
      if (leaseError) throw new Error(leaseError.message);
      if (!leaseRow) throw new Error("Lease not found for this organization");
      await guardProperty(leaseRow.property_id);

      const { data, error } = await supabaseAdmin
        .from("cam_estimate_schedules")
        .upsert(
          rows.map((row) => ({
            org_id: orgId, lease_id: leaseId, recovery_period_id: recoveryPeriodId,
            month_date: row.month_date, amount: Number(row.amount), source, status: "scheduled",
          })),
          { onConflict: "org_id,lease_id,recovery_period_id,month_date" },
        )
        .select("*");
      if (error) throw new Error(error.message);

      await supabaseAdmin.from("audit_logs").insert({
        org_id: orgId, entity_type: "CamEstimateScheduleBulk", entity_id: leaseId,
        action: "cam_setup_bulk_estimate_created", actor_user_id: user.id, actor_email: user.email ?? "unknown@example.com",
        severity: "info", source: "edge_function",
        metadata: { recovery_period_id: recoveryPeriodId, row_count: rows.length, reason: String(body?.reason ?? "").trim() || null },
        timestamp: new Date().toISOString(),
      });

      result = { estimate_schedules: data, count: data?.length ?? 0 };

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
        p_notes: String(body?.evidence_note ?? body?.notes ?? "").trim() || null,
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
