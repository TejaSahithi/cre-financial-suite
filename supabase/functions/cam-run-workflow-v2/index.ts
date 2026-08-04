// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 4A + 4B:
// operational workflow action dispatch sitting on top of the RPCs added in
// migrations 20269900000023 (Phase 4A) and 20269900000025 (Phase 4B).
//
// Phase 4A actions (always available):
//   submit_for_review, return_to_draft, approve, reject, resolve_exception
//
// Phase 4B actions (guarded by FEATURE_CAM_POSTING_ENABLED env var):
//   post_run               → post_cam_run RPC
//   generate_statements    → generate_cam_statements RPC
//   create_adjustment_run  → create_cam_adjustment_run RPC
//   create_restatement_run → create_cam_restatement_run RPC
//   supersede_run          → supersede_cam_run RPC
//   create_charge_export   → create_cam_charge_export RPC (idempotent)
//   cancel_charge_export   → cancel_unposted_cam_charge_export RPC
//   mark_export_delivered  → mark_cam_charge_export_delivered RPC
//
// Feature flag: the Phase 4B actions are BLOCKED if the environment variable
// FEATURE_CAM_POSTING_ENABLED is not exactly "true". This keeps the posting
// pipeline dormant in production until all Acceptance Gate items pass and an
// operator explicitly enables the flag.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHASE_4A_ACTIONS = new Set([
  "submit_for_review", "return_to_draft", "approve", "reject", "resolve_exception",
]);
const PHASE_4B_ACTIONS = new Set([
  "post_run",
  "generate_statements",
  "create_adjustment_run",
  "create_restatement_run",
  "supersede_run",
  "create_charge_export",
  "cancel_charge_export",
  "mark_export_delivered",
  "verify_gate",
]);

const VALID_RESOLUTION_STATUSES = new Set(["resolved", "waived"]);

const POSTING_ENABLED = Deno.env.get("FEATURE_CAM_POSTING_ENABLED") === "true";

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|feature.*disabled|posting.*disabled/i.test(message)) return 403;
  if (/required|not found|action must be|must be in status|must be submitted|must be under_review|resolution_status must be|cannot post|cannot supersede/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CAMRun", "CAMExceptionReview", "CAMApproval", "CAMSetup", "CAMDashboard", "CAMPosting"], "write");

    const body = await req.json().catch(() => ({}));
    const camRunId = String(body?.cam_run_id || "").trim();
    const action = String(body?.action || "").trim().toLowerCase();

    const allValidActions = new Set([...PHASE_4A_ACTIONS, ...PHASE_4B_ACTIONS]);
    if (!allValidActions.has(action)) {
      throw new Error(`action must be one of: ${[...allValidActions].join(", ")}`);
    }

    // Feature flag gate for Phase 4B actions
    if (PHASE_4B_ACTIONS.has(action) && !POSTING_ENABLED) {
      throw new Error(`Phase 4B posting is not enabled in this environment. Action '${action}' requires FEATURE_CAM_POSTING_ENABLED=true.`);
    }

    if (!UUID_RE.test(camRunId)) throw new Error("cam_run_id is required");

    const { data: runRow, error: runLookupError } = await supabaseAdmin
      .from("cam_runs").select("id, org_id, scope_type, scope_id")
      .eq("id", camRunId).eq("org_id", orgId).maybeSingle();
    if (runLookupError) throw new Error(`Failed to load cam_run: ${runLookupError.message}`);
    if (!runRow) throw new Error("CAM run not found for this organization");
    if (runRow.scope_type === "property" && runRow.scope_id) await assertPropertyAccess(req, runRow.scope_id);

    const actorArgs = { p_org_id: orgId, p_cam_run_id: camRunId, p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com" };

    let result: Record<string, unknown>;
    switch (action) {

      // ---- Phase 4A -----------------------------------------------------------

      case "submit_for_review": {
        const { data, error } = await supabaseAdmin.rpc("submit_cam_run_for_review", actorArgs);
        if (error) throw new Error(error.message);
        result = data;
        break;
      }
      case "return_to_draft": {
        const reason = String(body?.reason || "").trim();
        const { data, error } = await supabaseAdmin.rpc("return_cam_run_to_draft", { ...actorArgs, p_reason: reason });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }
      case "reject": {
        const reason = String(body?.reason || "").trim();
        const { data, error } = await supabaseAdmin.rpc("reject_cam_run", { ...actorArgs, p_reason: reason });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }
      case "approve": {
        const { data, error } = await supabaseAdmin.rpc("approve_cam_run", actorArgs);
        if (error) throw new Error(error.message);
        result = data;
        break;
      }
      case "resolve_exception": {
        const exceptionId = String(body?.exception_id || "").trim();
        const resolutionStatus = String(body?.resolution_status || "").trim().toLowerCase();
        const resolutionNote = String(body?.resolution_note || "").trim();
        if (!UUID_RE.test(exceptionId)) throw new Error("exception_id is required");
        if (!VALID_RESOLUTION_STATUSES.has(resolutionStatus)) throw new Error("resolution_status must be resolved or waived");
        if (!resolutionNote) throw new Error("resolution_note is required when resolving or waiving an exception");
        const { data, error } = await supabaseAdmin.rpc("resolve_cam_run_exception", {
          p_org_id: orgId, p_cam_run_id: camRunId, p_exception_id: exceptionId,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
          p_resolution_status: resolutionStatus, p_resolution_note: resolutionNote,
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      // ---- Phase 4B (FEATURE_CAM_POSTING_ENABLED guard checked above) ---------

      case "post_run": {
        const reason = String(body?.reason || "").trim() || null;
        const { data, error } = await supabaseAdmin.rpc("post_cam_run", { ...actorArgs, p_reason: reason });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "generate_statements": {
        const schemaVersion = String(body?.schema_version || "1.0").trim();
        const templateVersion = String(body?.template_version || "1.0").trim();
        const { data, error } = await supabaseAdmin.rpc("generate_cam_statements", {
          ...actorArgs, p_schema_version: schemaVersion, p_template_version: templateVersion,
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "create_adjustment_run": {
        const reason = String(body?.reason || "").trim();
        if (!reason) throw new Error("reason is required to create an adjustment run");
        const { data, error } = await supabaseAdmin.rpc("create_cam_adjustment_run", {
          p_org_id: orgId, p_original_run_id: camRunId, p_reason: reason,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "create_restatement_run": {
        const reason = String(body?.reason || "").trim();
        if (!reason) throw new Error("reason is required to create a restatement run");
        const { data, error } = await supabaseAdmin.rpc("create_cam_restatement_run", {
          p_org_id: orgId, p_superseded_run_id: camRunId, p_reason: reason,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "supersede_run": {
        const newRunId = String(body?.new_run_id || "").trim();
        if (!UUID_RE.test(newRunId)) throw new Error("new_run_id is required");
        const { data, error } = await supabaseAdmin.rpc("supersede_cam_run", {
          p_org_id: orgId, p_cam_run_id: camRunId, p_new_run_id: newRunId,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "create_charge_export": {
        const statementId = body?.statement_id ? String(body.statement_id).trim() : undefined;
        if (statementId && !UUID_RE.test(statementId)) throw new Error("statement_id must be a valid UUID");
        const { data, error } = await supabaseAdmin.rpc("create_cam_charge_export", {
          p_org_id: orgId, p_cam_run_id: camRunId,
          p_statement_id: statementId ?? null,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "cancel_charge_export": {
        const exportId = String(body?.export_id || "").trim();
        if (!UUID_RE.test(exportId)) throw new Error("export_id is required");
        const { data, error } = await supabaseAdmin.rpc("cancel_unposted_cam_charge_export", {
          p_org_id: orgId, p_export_id: exportId,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "mark_export_delivered": {
        const exportId = String(body?.export_id || "").trim();
        if (!UUID_RE.test(exportId)) throw new Error("export_id is required");
        const { data, error } = await supabaseAdmin.rpc("mark_cam_charge_export_delivered", {
          p_org_id: orgId, p_export_id: exportId,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      case "verify_gate": {
        const propertyId = String(body?.property_id || "").trim();
        const reviewNotes = String(body?.review_notes || "").trim();
        if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
        if (!reviewNotes) throw new Error("review_notes are required to verify the gate");
        const { data, error } = await supabaseAdmin.rpc("verify_cam_real_property_validation", {
          p_org_id: orgId, p_property_id: propertyId, p_cam_run_id: camRunId,
          p_review_notes: reviewNotes,
          p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
        });
        if (error) throw new Error(error.message);
        result = data;
        break;
      }

      default:
        throw new Error("Unhandled action");
    }

    return jsonResponse({ action, ...result }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, errorStatus(message));
  }
});
