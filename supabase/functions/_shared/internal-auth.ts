// @ts-nocheck
/**
 * Internal call detection for edge functions that accept both user-JWT and
 * service-to-service calls (e.g. parse-document-azure called from lease-extraction-worker).
 *
 * Three accepted forms:
 *   1. x-worker-secret header == WORKER_INTERNAL_SECRET
 *   2. Authorization Bearer token == SUPABASE_SERVICE_ROLE_KEY
 *   3. x-internal-service-key header == SUPABASE_SERVICE_ROLE_KEY
 *      (set by buildInternalFunctionHeaders in lease-extraction-worker/auth.ts)
 */
export interface EnvSource {
  get(key: string): string | undefined | null;
}

export function isInternalCall(req: Request, env: EnvSource = Deno.env): boolean {
  const workerSecret = String(env.get("WORKER_INTERNAL_SECRET") ?? "").trim();
  const serviceKey = String(env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const providedSecret = req.headers.get("x-worker-secret")?.trim() ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const internalKey = req.headers.get("x-internal-service-key")?.trim() ?? "";
  return Boolean(
    (workerSecret && providedSecret === workerSecret) ||
    (serviceKey && bearer === serviceKey) ||
    (serviceKey && internalKey === serviceKey),
  );
}

/** Extracts the org_id from x-internal-org-id when the call is internal. */
export function extractInternalOrgIdFromHeader(req: Request, env: EnvSource = Deno.env): string {
  if (!isInternalCall(req, env)) return "";
  const raw = req.headers.get("x-internal-org-id")?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : "";
}
