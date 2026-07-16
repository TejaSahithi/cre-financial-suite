// @ts-nocheck
/**
 * Document Intelligence v3 — Projection Reader (Phase 3)
 *
 * Thin, read-only data-access functions over the durable v3 tables
 * (document_intelligence_runs, document_claims, document_claim_evidence,
 * document_validation_drops, document_canonical_field_projections). No
 * business logic lives here -- readiness.ts owns interpretation; this
 * module only owns "how do I fetch this row set", so the query shape is
 * defined in exactly one place.
 *
 * Every function takes the caller's own org_id and filters by it
 * explicitly, in addition to the RLS SELECT policies already scoping these
 * tables (is_member_of_org(org_id)) -- defense in depth, matching the
 * pattern every other edge function in this repo already follows.
 */

export interface ProjectionReaderDeps {
  supabaseAdmin: any;
}

export interface ResolveRunInput extends ProjectionReaderDeps {
  orgId: string;
  runId?: string | null;
  uploadedFileId?: string | null;
}

/**
 * Resolves the run to evaluate:
 *   - runId given: fetch that exact run (any status -- an explicit request
 *     for a specific run_id is allowed to inspect a failed run).
 *   - uploadedFileId given (no runId): fetch the latest run with
 *     status='completed' for that file. Failed/skipped/running runs are
 *     ignored in this path (Phase 3 Task F.9) -- diagnosing a document by
 *     file id should never surface an incomplete run's partial data.
 * Returns null if neither resolves to a row (not an error -- "no v3 data
 * yet" is a normal, expected outcome for a flag-off or not-yet-processed
 * file).
 */
export async function resolveRun(input: ResolveRunInput): Promise<Record<string, unknown> | null> {
  const { supabaseAdmin, orgId, runId, uploadedFileId } = input;

  if (runId) {
    const { data, error } = await supabaseAdmin
      .from("document_intelligence_runs")
      .select("*")
      .eq("id", runId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve document_intelligence_runs by id: ${error.message}`);
    return data ?? null;
  }

  if (uploadedFileId) {
    const { data, error } = await supabaseAdmin
      .from("document_intelligence_runs")
      .select("*")
      .eq("uploaded_file_id", uploadedFileId)
      .eq("org_id", orgId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve latest completed document_intelligence_runs row: ${error.message}`);
    return data ?? null;
  }

  return null;
}

export async function fetchRunClaims(input: ProjectionReaderDeps & { orgId: string; runId: string }) {
  const { supabaseAdmin, orgId, runId } = input;
  const { data, error } = await supabaseAdmin
    .from("document_claims")
    .select("*")
    .eq("run_id", runId)
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to fetch document_claims: ${error.message}`);
  return data ?? [];
}

export async function fetchClaimEvidence(input: ProjectionReaderDeps & { orgId: string; claimIds: string[] }) {
  const { supabaseAdmin, orgId, claimIds } = input;
  if (!claimIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from("document_claim_evidence")
    .select("*")
    .in("claim_id", claimIds)
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to fetch document_claim_evidence: ${error.message}`);
  return data ?? [];
}

export async function fetchRunValidationDrops(input: ProjectionReaderDeps & { orgId: string; runId: string }) {
  const { supabaseAdmin, orgId, runId } = input;
  const { data, error } = await supabaseAdmin
    .from("document_validation_drops")
    .select("*")
    .eq("run_id", runId)
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to fetch document_validation_drops: ${error.message}`);
  return data ?? [];
}

export async function fetchRunCanonicalFieldProjections(input: ProjectionReaderDeps & { orgId: string; runId: string }) {
  const { supabaseAdmin, orgId, runId } = input;
  const { data, error } = await supabaseAdmin
    .from("document_canonical_field_projections")
    .select("*")
    .eq("run_id", runId)
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to fetch document_canonical_field_projections: ${error.message}`);
  return data ?? [];
}
