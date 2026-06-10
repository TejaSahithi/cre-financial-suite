// @ts-nocheck

export const UNAUTHORIZED_WORKER_RESPONSE = {
  ok: false,
  error_code: "UNAUTHORIZED_WORKER_CALL",
  message: "Unauthorized worker call",
};

export function extractBearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

export function isAuthorizedWorkerCall(
  req: Request,
  env: { get(key: string): string | undefined | null } = Deno.env,
): boolean {
  const serviceKey = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret = env.get("WORKER_INTERNAL_SECRET") ?? "";
  const providedWorkerSecret = req.headers.get("x-worker-secret")?.trim() ?? "";

  return Boolean(
    (workerSecret && providedWorkerSecret === workerSecret) ||
      (serviceKey && extractBearerToken(req) === serviceKey),
  );
}
