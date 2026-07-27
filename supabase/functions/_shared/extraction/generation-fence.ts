// @ts-nocheck
/**
 * Shared generation-fencing check for the bounded per-domain enrich stages
 * (see FAILED_EXTRACTION_ROOT_CAUSE.md and the "Bounded Per-Domain Enrich
 * Refactor" plan).
 *
 * Before this module existed, "is this still the file's active generation?"
 * was checked by independently re-reading and comparing active_generation_id
 * in at least 3 separate places (lease-extraction-worker/index.ts's
 * max-attempts-exceeded path, its enrich-failure path, and
 * completeEnrichmentWithWarning; plus normalize-pdf-output's own
 * isEnrichGenerationStale() closure) -- each a hand-copied 4-line check with
 * no shared implementation. The bounded-stage refactor adds up to 10 new
 * stages, each of which needs this same check at every write site; this
 * module gives them one implementation to share instead of an 4th-13th copy.
 *
 * The check must be re-run immediately before every write, not just once at
 * the start of a stage -- compute in between (LLM calls, large regex
 * sweeps) can take long enough for a newer generation to have started.
 */

export interface GenerationFenceCheck {
  /** true if expectedGenerationId is still the file's active_generation_id. */
  stillActive: boolean;
  /** The file's current active_generation_id, whatever it is now. */
  currentGenerationId: string | null;
}

export async function checkGenerationStillActive(args: {
  supabaseAdmin: any;
  fileId: string;
  orgId: string;
  expectedGenerationId: string | null | undefined;
}): Promise<GenerationFenceCheck> {
  const { supabaseAdmin, fileId, orgId, expectedGenerationId } = args;
  const { data: fileRow } = await supabaseAdmin
    .from("uploaded_files")
    .select("active_generation_id")
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();

  const currentGenerationId = fileRow?.active_generation_id ?? null;
  // A null expectedGenerationId (a job created before generation fencing
  // existed, or a caller that never resolved one) is treated as "not
  // fenced" -- matches the existing lenient behavior at every ad hoc call
  // site this replaces, none of which block a null expected id.
  const stillActive = expectedGenerationId == null || currentGenerationId === expectedGenerationId;
  return { stillActive, currentGenerationId };
}
