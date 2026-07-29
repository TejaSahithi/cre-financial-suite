// @ts-nocheck
/**
 * Whole-document LLM extraction experiment.
 *
 * OFF is deliberately the default. ACTIVE changes the authoritative OpenAI
 * extraction path for lease documents: the model receives the complete,
 * compact Azure document and writes directly to the lease schema. The
 * section router, deterministic readiness gate, and fact-field mapper are
 * not used by that path.
 *
 * This is a server-side deployment control. Never accept it from a request.
 */

const FLAG_NAME = "LEASE_WHOLE_DOCUMENT_LLM_V1";

export type WholeDocumentLlmMode = "off" | "active";

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getWholeDocumentLlmMode(env: EnvLike = Deno.env): WholeDocumentLlmMode {
  return String(env.get(FLAG_NAME) ?? "").trim().toLowerCase() === "active"
    ? "active"
    : "off";
}

export function isWholeDocumentLlmActive(env: EnvLike = Deno.env): boolean {
  return getWholeDocumentLlmMode(env) === "active";
}

export const WHOLE_DOCUMENT_LLM_FLAG_NAME = FLAG_NAME;
