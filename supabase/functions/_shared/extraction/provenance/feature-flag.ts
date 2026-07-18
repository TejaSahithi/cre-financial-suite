// @ts-nocheck
/**
 * Extraction Provenance — Feature Flag (P1)
 *
 * Structural copy of document-intelligence-v3/feature-flag.ts's template
 * (same TRUTHY_VALUES set, injectable EnvLike for testability, default-false
 * on anything else). Gates every write this phase adds: extraction_runs,
 * extraction_stage_runs, provider_invocations, extraction_artifacts.
 *
 * Unlike the v3 flag (one call site, side-write.ts), P1 instruments
 * multiple stages across multiple files — so the check lives here, in one
 * place, and is called by the recorder module's own functions
 * (startExtractionRun/withExtractionStage/recordProviderInvocation/
 * storeArtifact), each of which no-ops when this returns false. Call sites
 * in parse-pdf-docling/normalize-pdf-output/lease-extraction-worker/the
 * provider transport wrappers call the recorder unconditionally; the gate
 * logic itself exists in exactly this one tested place.
 *
 * The one deviation from a pure env-var read: start_lease_extraction_generation
 * (the RPC, not this module) receives the resolved boolean through
 * p_metadata.provenance_enabled, set by the calling Edge Function after
 * reading this flag — never read directly by the browser, and never
 * inferred inside the RPC itself. This module is what the Edge Function
 * calls to resolve that boolean before making the RPC call.
 */

const FLAG_NAME = "ENABLE_EXTRACTION_PROVENANCE";

const TRUTHY_VALUES = new Set(["true", "1", "on", "yes"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function isExtractionProvenanceEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export const EXTRACTION_PROVENANCE_FLAG_NAME = FLAG_NAME;
