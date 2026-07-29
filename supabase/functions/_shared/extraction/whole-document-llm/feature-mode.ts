// @ts-nocheck
/**
 * Authoritative whole-document LLM extraction mode.
 *
 * ACTIVE is mandatory for lease documents. For lease documents, the model receives
 * the complete compact Azure document and writes directly to the lease schema.
 * The section router, deterministic readiness gate, and fact-field mapper are
 * not used by that path.
 *
 * The previous "off" rollback flag is intentionally ignored by runtime code.
 * Legacy extraction may still run as the orchestrator's marked fallback after
 * the primary whole-document LLM attempt fails acceptance, but it may not be
 * selected as the primary lease architecture by env drift.
 *
 * This is a server-side deployment control. Never accept it from a request.
 */

const FLAG_NAME = "LEASE_WHOLE_DOCUMENT_LLM_V1";

export type WholeDocumentLlmMode = "active";

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getWholeDocumentLlmMode(env: EnvLike = Deno.env): WholeDocumentLlmMode {
  // Read the env only to keep the call side-effect-compatible with tests and
  // diagnostics that pass a fake env. The value does not control production
  // lease extraction anymore.
  void env.get(FLAG_NAME);
  return "active";
}

export function isWholeDocumentLlmActive(env: EnvLike = Deno.env): boolean {
  void getWholeDocumentLlmMode(env);
  return true;
}

export const WHOLE_DOCUMENT_LLM_FLAG_NAME = FLAG_NAME;
