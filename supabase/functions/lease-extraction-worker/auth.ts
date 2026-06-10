// @ts-nocheck

export const UNAUTHORIZED_WORKER_RESPONSE = {
  ok: false,
  error_code: "UNAUTHORIZED_WORKER_CALL",
  message: "Unauthorized worker call",
};

export const REQUIRED_WORKER_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKER_INTERNAL_SECRET",
] as const;

export type WorkerEnv = { get(key: string): string | undefined | null };

export function extractBearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

export function isAuthorizedWorkerCall(
  req: Request,
  env: WorkerEnv = Deno.env,
): boolean {
  const serviceKey = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret = env.get("WORKER_INTERNAL_SECRET") ?? "";
  const providedWorkerSecret = req.headers.get("x-worker-secret")?.trim() ?? "";

  return Boolean(
    (workerSecret && providedWorkerSecret === workerSecret) ||
      (serviceKey && extractBearerToken(req) === serviceKey),
  );
}

export function getMissingWorkerConfig(env: WorkerEnv = Deno.env): string[] {
  return REQUIRED_WORKER_ENV_KEYS.filter((key) => !String(env.get(key) ?? "").trim());
}

export function buildInternalFunctionHeaders(
  orgId?: string | null,
  env: WorkerEnv = Deno.env,
): HeadersInit {
  const serviceKey = String(env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const workerSecret = String(env.get("WORKER_INTERNAL_SECRET") ?? "").trim();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
    "apikey": serviceKey,
    ...(orgId ? { "x-internal-org-id": orgId } : {}),
    ...(serviceKey ? { "x-internal-service-key": serviceKey } : {}),
    ...(workerSecret ? { "x-worker-secret": workerSecret } : {}),
  };
}

export function classifyDownstreamError(status: number): {
  error_code: string;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { error_code: "DOWNSTREAM_AUTH_FAILED", retryable: false };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { error_code: "DOWNSTREAM_FUNCTION_FAILED", retryable: true };
  }
  return { error_code: "DOWNSTREAM_FUNCTION_FAILED", retryable: false };
}
