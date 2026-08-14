// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { canVendorPerformService } from "../_shared/vendors/vendor-eligibility.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|invalid/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Vendors", "Expenses", "LeaseExpenseRules"], "read");

    const body = await req.json().catch(() => ({}));
    const vendorId = String(body.vendor_id ?? body.vendorId ?? "").trim();
    const serviceType = String(body.service_type ?? body.serviceType ?? "").trim();
    const jurisdiction = String(body.jurisdiction ?? "").trim() || null;
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? new Date().toISOString().slice(0, 10)).trim();

    if (!UUID_RE.test(vendorId)) throw new Error("vendor_id is required");
    if (!serviceType) throw new Error("service_type is required");
    if (!DATE_RE.test(asOfDate)) throw new Error("as_of_date is required in YYYY-MM-DD format");

    const { data: credentials, error } = await supabaseAdmin
      .from("vendor_credentials")
      .select("*")
      .eq("org_id", orgId)
      .eq("vendor_id", vendorId);
    if (error) throw new Error(`Failed to load vendor credentials: ${error.message}`);

    const result = canVendorPerformService({ vendorId, serviceType, jurisdiction, asOfDate, credentials: credentials ?? [] });
    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "vendor_eligibility_decision",
      entityId: vendorId,
      action: "VENDOR_ELIGIBILITY_CHECKED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      source: "check-vendor-eligibility",
      newValue: { service_type: serviceType, jurisdiction, as_of_date: asOfDate, result },
    });
    return jsonResponse({ error: false, data: result });
  } catch (error) {
    const message = error?.message || "Could not check vendor eligibility";
    console.error("[check-vendor-eligibility]", message);
    return jsonResponse({ error: true, message, error_code: "CHECK_VENDOR_ELIGIBILITY_FAILED" }, errorStatus(message));
  }
});
