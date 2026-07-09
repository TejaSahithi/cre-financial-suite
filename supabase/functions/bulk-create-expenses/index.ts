// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

function validatePayload(body: Record<string, unknown> = {}) {
  const expenses = body.expenses;
  if (!Array.isArray(expenses) || expenses.length === 0) {
    throw new Error("expenses is required and must be a non-empty array");
  }
  for (const row of expenses) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("each expense must be an object");
    }
  }
  return { expenses };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be a|must be an object|must contain|is not permitted|non-negative/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["BulkImport"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("bulk_create_expenses_workflow", {
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_expenses: payload.expenses,
    });

    if (error) {
      throw new Error(error.message || "bulk_create_expenses_workflow failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not import expenses";
    return jsonResponse({
      error: true,
      message,
      error_code: "BULK_CREATE_EXPENSES_FAILED",
    }, errorStatus(message));
  }
});
