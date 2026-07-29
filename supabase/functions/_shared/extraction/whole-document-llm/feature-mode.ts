// @ts-nocheck
/**
 * Authoritative whole-document LLM extraction mode.
 *
 * ACTIVE is deliberately the default. For lease documents, the model receives
 * the complete compact Azure document and writes directly to the lease schema.
 * The section router, deterministic readiness gate, and fact-field mapper are
 * not used by that path.
 *
 * The legacy architecture is available only through the explicit "off"
 * rollback value. Unset, blank, or misspelled values must never silently
 * reactivate TypeScript evidence selection/mapping.
 *
 * This is a server-side deployment control. Never accept it from a request.
 */

const FLAG_NAME = "LEASE_WHOLE_DOCUMENT_LLM_V1";

export type WholeDocumentLlmMode = "off" | "active";

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getWholeDocumentLlmMode(env: EnvLike = Deno.env): WholeDocumentLlmMode {
  return String(env.get(FLAG_NAME) ?? "").trim().toLowerCase() === "off"
    ? "off"
    : "active";
}

export function isWholeDocumentLlmActive(env: EnvLike = Deno.env): boolean {
  return getWholeDocumentLlmMode(env) === "active";
}

export const WHOLE_DOCUMENT_LLM_FLAG_NAME = FLAG_NAME;
