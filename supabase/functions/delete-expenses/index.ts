// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const rawIds = body.expense_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("expense_ids is required");
  }

  const expenseIds = rawIds.map((id) => String(id || "").trim());
  for (const id of expenseIds) {
    if (!UUID_RE.test(id)) {
      throw new Error("expense_ids must contain only valid UUIDs");
    }
  }

  return { expenseIds };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must contain only/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Expenses"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("delete_expenses_workflow", {
      p_org_id: orgId,
      p_expense_ids: payload.expenseIds,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
    });

    if (error) {
      throw new Error(error.message || "delete_expenses_workflow failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not delete expense(s)";
    return jsonResponse({
      error: true,
      message,
      error_code: "DELETE_EXPENSES_FAILED",
    }, errorStatus(message));
  }
});
