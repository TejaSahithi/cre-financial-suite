// @ts-nocheck
/**
 * Lease Claims Ledger — mode flag (P2.2).
 *
 * Structural copy of provenance/feature-flag.ts's template (injectable
 * EnvLike, default-closed on anything unrecognized) — three-value parse
 * instead of boolean:
 *   - "off":    no P2 rows, no output changes (current behavior unchanged).
 *   - "shadow": claims persisted and projected, but legacy JSON stays
 *               authoritative for runtime output.
 *   - "active": claims projection becomes authoritative; no legacy fallback.
 * Invalid or unset resolves to "off" -- never throws, never defaults open.
 *
 * Read only server-side (Edge Function env var) -- never accept a mode
 * value from the request body, mirroring how P1.2's provenance_enabled
 * flag is resolved by the calling Edge Function and passed down, never
 * inferred from caller input.
 */

const FLAG_NAME = "LEASE_CLAIMS_LEDGER_MODE";

export type LeaseClaimsLedgerMode = "off" | "shadow" | "active";

const VALID_MODES: ReadonlySet<LeaseClaimsLedgerMode> = new Set(["off", "shadow", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseClaimsLedgerMode(env: EnvLike = Deno.env): LeaseClaimsLedgerMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return VALID_MODES.has(raw) ? (raw as LeaseClaimsLedgerMode) : "off";
}

export function isClaimsLedgerActive(env: EnvLike = Deno.env): boolean {
  return getLeaseClaimsLedgerMode(env) === "active";
}

export function isClaimsLedgerAtLeastShadow(env: EnvLike = Deno.env): boolean {
  const mode = getLeaseClaimsLedgerMode(env);
  return mode === "shadow" || mode === "active";
}

export const LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME = FLAG_NAME;
