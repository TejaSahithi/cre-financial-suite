// @ts-nocheck
/**
 * get-extraction-artifact — P1.5
 *
 * The only way raw extraction-provenance artifact content (parser raw
 * output, provider raw request/response, normalized snapshots) reaches a
 * caller. Two-boundary design (round-3 review): a plain SQL function
 * cannot itself mint a Supabase Storage signed URL, so:
 *
 *   get_extraction_artifact_authorization (SQL RPC) -- verifies org
 *     membership + a privileged role, verifies the artifact belongs to
 *     that org, writes one audit_logs row unconditionally, then returns
 *     EITHER the inline content OR the artifact's OWN storage_bucket/path
 *     (never a caller-supplied one)
 *         |
 *         v
 *   this Edge Function -- for storage_object rows, mints a short-TTL
 *     signed URL from the bucket/path the RPC already authorized
 *
 * The RPC is called through a USER-SCOPED client (anon key + the caller's
 * own bearer token forwarded), not the admin client -- get_extraction_artifact_authorization
 * relies entirely on auth.uid() to resolve the real caller identity for both
 * its authorization decision and its audit-log attribution; calling it via
 * the service-role client would make auth.uid() resolve to nothing. Only
 * the signed-URL minting step (which needs elevated Storage access this
 * bucket deliberately grants no one via RLS) uses the admin client.
 *
 * The browser can never supply its own bucket/path here -- only
 * artifact_id is accepted from the request body.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, createUserScopedClient, verifyUser, getUserOrgId } from "../_shared/supabase.ts";

const SIGNED_URL_TTL_SECONDS = 180; // 60-300s per plan; 3 minutes is enough for a debug/audit viewer to load the content

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

    const body = await req.json().catch(() => ({}));
    const { artifact_id } = body;
    if (!artifact_id) {
      return jsonResponse(
        { error: true, message: "artifact_id is required", error_code: "MISSING_ARTIFACT_ID" },
        400,
      );
    }

    // auth.uid() inside the RPC must resolve to the real caller -- use the
    // user-scoped client (forwards the caller's own JWT), never the admin
    // client, which would make auth.uid() resolve to nothing and defeat
    // the RPC's entire authorization/audit model.
    const scopedClient = createUserScopedClient(req);
    const { data: authResult, error: authRpcError } = await scopedClient.rpc(
      "get_extraction_artifact_authorization",
      { p_org_id: orgId, p_artifact_id: artifact_id },
    );

    if (authRpcError) {
      // The RPC itself distinguishes "not a member" / "not privileged" /
      // "not found" via its own RAISE EXCEPTION messages -- surface as 403
      // rather than guessing a more specific code from message text.
      return jsonResponse(
        { error: true, message: authRpcError.message, error_code: "ARTIFACT_ACCESS_DENIED" },
        403,
      );
    }

    if (authResult?.storage_mode === "inline") {
      return jsonResponse({
        error: false,
        artifact_id: authResult.artifact_id,
        storage_mode: "inline",
        content_type: authResult.content_type,
        byte_size: authResult.byte_size,
        truncated: authResult.truncated,
        content: authResult.content,
      });
    }

    if (authResult?.storage_mode === "storage_object") {
      // Signed URL minting needs the admin client -- this bucket grants no
      // RLS access to anyone, by design (see the migration comment), so
      // only the service-role client can reach it at all.
      const { data: signedData, error: signError } = await supabaseAdmin
        .storage
        .from(authResult.storage_bucket)
        .createSignedUrl(authResult.storage_path, SIGNED_URL_TTL_SECONDS);

      if (signError || !signedData?.signedUrl) {
        return jsonResponse(
          { error: true, message: `Could not generate signed URL: ${signError?.message ?? "unknown error"}`, error_code: "SIGNED_URL_FAILED" },
          500,
        );
      }

      return jsonResponse({
        error: false,
        artifact_id: authResult.artifact_id,
        storage_mode: "storage_object",
        content_type: authResult.content_type,
        byte_size: authResult.byte_size,
        sha256: authResult.sha256,
        signed_url: signedData.signedUrl,
        expires_in_seconds: SIGNED_URL_TTL_SECONDS,
      });
    }

    return jsonResponse(
      { error: true, message: "Unexpected authorization response shape", error_code: "ARTIFACT_ACCESS_DENIED" },
      500,
    );
  } catch (err: any) {
    console.error("[get-extraction-artifact] Error:", err?.message ?? err);
    const errMsg = String(err?.message ?? "");
    const isAuthError = /unauthorized|missing authorization|invalid token/i.test(errMsg);
    return jsonResponse(
      { error: true, message: errMsg, error_code: isAuthError ? "UNAUTHORIZED_ARTIFACT_CALL" : "ARTIFACT_RETRIEVAL_FAILED" },
      isAuthError ? 401 : 400,
    );
  }
});
