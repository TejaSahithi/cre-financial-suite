// @ts-nocheck
import { corsHeaders } from "./cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "./supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_RESOLUTIONS = new Set(["recoverable", "non_recoverable"]);

export function validateResolveConditionPayload(body: Record<string, unknown> = {}) {
  const classificationId = String(body.classification_id || body.classificationId || "").trim();
  const resolution = String(body.resolution || "").trim().toLowerCase();
  const reason = String(body.reason || "").trim();
  const evidence = body.evidence && typeof body.evidence === "object" ? body.evidence : null;

  if (!UUID_RE.test(classificationId)) {
    throw new Error("classification_id is required");
  }
  if (!ALLOWED_RESOLUTIONS.has(resolution)) {
    throw new Error("resolution must be recoverable or non_recoverable");
  }
  if (!reason) {
    throw new Error("reason is required");
  }

  return { classificationId, resolution, reason, evidence };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|organization|outside/i.test(message)) return 403;
  if (/required|resolution|reason|not conditional/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

export async function handleResolveExpenseClassificationConditionRequest(req: Request) {
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "ExpenseReview", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validateResolveConditionPayload(body);

    const { data, error } = await supabaseAdmin.rpc("resolve_expense_classification_condition", {
      p_org_id: orgId,
      p_classification_id: payload.classificationId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_resolution: payload.resolution,
      p_reason: payload.reason,
      p_evidence: payload.evidence,
    });

    if (error) {
      throw new Error(error.message || "resolve_expense_classification_condition failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Resolve expense classification condition failed";
    return jsonResponse({
      error: true,
      message,
      error_code: "RESOLVE_EXPENSE_CLASSIFICATION_CONDITION_FAILED",
    }, errorStatus(message));
  }
}
