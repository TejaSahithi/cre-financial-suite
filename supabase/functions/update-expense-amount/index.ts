// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const expenseId = String(body.expense_id || "").trim();
  if (!UUID_RE.test(expenseId)) {
    throw new Error("expense_id is required");
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("amount must be a non-negative number");
  }

  return { expenseId, amount };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be a/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["Expenses", "LeaseExpenseClassification"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("update_expense_amount", {
      p_org_id: orgId,
      p_expense_id: payload.expenseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_amount: payload.amount,
    });

    if (error) {
      throw new Error(error.message || "update_expense_amount failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not update expense amount";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_EXPENSE_AMOUNT_FAILED",
    }, errorStatus(message));
  }
});
