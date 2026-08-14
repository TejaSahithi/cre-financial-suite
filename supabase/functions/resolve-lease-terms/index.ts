// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";

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
    await assertPageAccess(req, orgId, ["LeaseReview", "Leases"], "read");

    const body = await req.json().catch(() => ({}));
    const leaseId = String(body.lease_id ?? body.leaseId ?? "").trim();
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? "").trim();

    if (!leaseId) {
      return jsonResponse({ error: true, error_code: "LEASE_ID_REQUIRED", message: "lease_id is required" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return jsonResponse({
        error: true,
        error_code: "AS_OF_DATE_REQUIRED",
        message: "as_of_date is required in YYYY-MM-DD format",
      }, 400);
    }

    const snapshot = await loadLeaseTermsSnapshot(supabaseAdmin, { orgId, leaseId });
    if (!snapshot) {
      return jsonResponse({
        error: true,
        message: "Lease not found for this organization",
        error_code: "LEASE_NOT_FOUND",
      }, 404);
    }

    const resolved = resolveLeaseTerms(snapshot, asOfDate);
    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "resolved_lease_terms",
      entityId: leaseId,
      action: "LEASE_TERMS_RESOLVED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      propertyId: snapshot.propertyId ?? null,
      source: "resolve-lease-terms",
      newValue: { as_of_date: asOfDate, unresolved_terms: resolved.unresolvedTerms, source_evidence: resolved.sourceEvidence },
    });

    return jsonResponse({ data: resolved });
  } catch (error) {
    console.error("[resolve-lease-terms]", error);
    return jsonResponse({
      error: true,
      message: error instanceof Error ? error.message : "Failed to resolve lease terms",
    }, 500);
  }
});