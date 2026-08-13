// @ts-nocheck
// Thin HTTP wrapper around the pure lease-terms facade. Auth/org-check
// pattern is a byte-for-byte match of approve-lease-workflow/index.ts,
// with "read" access instead of "write" since this never mutates data.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";

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
    const leaseId = body.leaseId || body.lease_id;
    const asOfDate = body.asOfDate || body.as_of_date || new Date().toISOString().slice(0, 10);

    if (!leaseId) {
      return jsonResponse({ error: true, message: "leaseId is required", error_code: "LEASE_ID_REQUIRED" }, 400);
    }

    const snapshot = await loadLeaseTermsSnapshot(supabaseAdmin, { orgId, leaseId });
    if (!snapshot) {
      return jsonResponse({ error: true, message: "Lease not found for this organization", error_code: "LEASE_NOT_FOUND" }, 404);
    }

    const resolved = resolveLeaseTerms(snapshot, asOfDate);
    return jsonResponse(resolved);
  } catch (error) {
    // Same status-code mapping as approve-lease-workflow/index.ts's outer
    // catch: transport/auth failures (verifyUser/getUserOrgId/assertPageAccess
    // all just `throw new Error(...)` with no status of their own) get the
    // right HTTP status instead of a flat 500. Domain-level gaps
    // (RENT_SCHEDULE_GAP, etc.) never reach this catch — resolveLeaseTerms
    // returns them in a 200 response's unresolvedTerms[], it never throws
    // for them.
    const message = error instanceof Error ? error.message : String(error);
    const status = /unauthorized|missing authorization/i.test(message)
      ? 401
      : /access denied|permission/i.test(message)
        ? 403
        : 500;
    return jsonResponse({ error: true, message, error_code: "RESOLVE_LEASE_TERMS_FAILED" }, status);
  }
});
