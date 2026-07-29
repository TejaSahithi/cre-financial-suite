// @ts-nocheck

export function envBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Deno.env.get(name);
  const value = raw ? Number(raw) : fallback;
  const parsed = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

// Supabase request idle/compute limits mean these are orchestration budgets,
// not "make the whole lease extraction fit in one request" budgets.
export const INGEST_EDGE_CALL_TIMEOUT_MS = 45_000;
export const INGEST_MAX_WAIT_MS = 135_000;
export const INGEST_RESPONSE_SAFETY_MS = 10_000;
export const INGEST_STATUS_READ_TIMEOUT_MS = 10_000;

export function ingestParseTimeoutMs() {
  return envBoundedInt("INGEST_PARSE_TIMEOUT_MS", 90_000, 30_000, 120_000);
}

export function ingestNormalizeTimeoutCeilingMs() {
  return envBoundedInt("INGEST_NORMALIZE_TIMEOUT_MS", 90_000, 20_000, 120_000);
}

export const LEASE_WORKER_PARSE_TIMEOUT_MS = envBoundedInt("LEASE_WORKER_PARSE_TIMEOUT_MS", 140_000, 30_000, 145_000);
export const LEASE_WORKER_CHAINED_NORMALIZE_TIMEOUT_MS = envBoundedInt("LEASE_WORKER_CHAINED_NORMALIZE_TIMEOUT_MS", 90_000, 20_000, 120_000);
export const LEASE_WORKER_NORMALIZE_TIMEOUT_MS = envBoundedInt("LEASE_WORKER_NORMALIZE_TIMEOUT_MS", 130_000, 30_000, 145_000);
export const LEASE_WORKER_NORMALIZE_RETRY_DELAY_MS = envBoundedInt("LEASE_WORKER_NORMALIZE_RETRY_DELAY_MS", 30_000, 5_000, 300_000);
export const LEASE_WORKER_NORMALIZE_ACTIVE_GRACE_MS = envBoundedInt("LEASE_WORKER_NORMALIZE_ACTIVE_GRACE_MS", 180_000, 60_000, 900_000);
export const LEASE_WORKER_ENRICH_TIMEOUT_MS = envBoundedInt("LEASE_WORKER_ENRICH_TIMEOUT_MS", 130_000, 30_000, 145_000);
export const LEASE_WORKER_BOUNDED_ENRICH_STAGE_TIMEOUT_MS = envBoundedInt("LEASE_WORKER_BOUNDED_ENRICH_STAGE_TIMEOUT_MS", 60_000, 15_000, 120_000);
