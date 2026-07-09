// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

function validatePayload(body: Record<string, unknown> = {}) {
  const expense = body.expense;
  if (!expense || typeof expense !== "object" || Array.isArray(expense)) {
    throw new Error("expense must be an object");
  }
  return { expense };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/not found/i.test(message)) return 400;
  if (/required|must be one of|is not permitted|must be a/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["Expenses", "AddExpense", "BulkImport"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("create_expense_workflow", {
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_expense: payload.expense,
    });

    if (error) {
      throw new Error(error.message || "create_expense_workflow failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not create expense";
    return jsonResponse({
      error: true,
      message,
      error_code: "CREATE_EXPENSE_WORKFLOW_FAILED",
    }, errorStatus(message));
  }
});
