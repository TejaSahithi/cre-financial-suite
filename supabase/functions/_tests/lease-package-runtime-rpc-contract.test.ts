// @ts-nocheck
// P3.7 -- package runtime SQL/RPC/finalizer contract tests.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migration = await Deno.readTextFile("supabase/migrations/20260847000000_lease_package_runtime_p3_7.sql");
const normalize = await Deno.readTextFile("supabase/functions/normalize-pdf-output/index.ts");
const worker = await Deno.readTextFile("supabase/functions/lease-extraction-worker/index.ts");
const saveDraft = await Deno.readTextFile("supabase/functions/save-lease-review-draft/index.ts");

Deno.test("P3.7 write-back 37/38/39/40/41/44/45/46/47/48: narrow package compatibility RPC is service-role, fenced and idempotent", () => {
  assert(migration.includes("CREATE TABLE IF NOT EXISTS public.lease_package_compatibility_writes"));
  assert(migration.includes("CREATE OR REPLACE FUNCTION public.persist_lease_package_claim_projection"));
  assert(migration.includes("IF auth.uid() IS NOT NULL"));
  assert(migration.includes("GRANT EXECUTE ON FUNCTION public.persist_lease_package_claim_projection"));
  assert(migration.includes("TO service_role"));
  assert(migration.includes("key NOT IN ('fields', 'field_evidence', 'confidence_scores', 'custom_fields', 'discovered_fields', 'rejected_fields')"));
  for (const rejected of ["raw_claims", "relationships", "workflow_output", "expense_rules", "cam_profile", "budget_preview", "provider_metadata", "artifact_path"]) {
    assert(migration.includes(`'${rejected}'`));
  }
  for (const code of [
    "PACKAGE_PROJECTION_WRITE_STALE_GENERATION",
    "PACKAGE_PROJECTION_WRITE_RUN_MISMATCH",
    "PACKAGE_PROJECTION_WRITE_NOT_COMPLETED",
    "PACKAGE_PROJECTION_WRITE_INVALID_PATCH",
    "PACKAGE_PROJECTION_WRITE_TOO_LARGE",
    "PACKAGE_PROJECTION_WRITE_APPROVED_LEASE",
    "PACKAGE_PROJECTION_WRITE_IDEMPOTENCY_CONFLICT",
  ]) {
    assert(migration.includes(code));
  }
  assert(migration.includes("digest(p_compatibility_patch::text, 'sha256')"));
  assert(migration.includes("idempotent_replay"));
  assert(!migration.includes("workflow_output ="));
});

Deno.test("P3.7 finalizer 25/26/27/28/29/31/33/34/35/36: one authoritative finalizer signature with package-active blockers", () => {
  const creates = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.finalize_lease_extraction_for_review\(/g)].length;
  assertEquals(creates, 1);
  assert(migration.includes("DROP FUNCTION IF EXISTS public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT);"));
  assert(migration.includes("p_package_mode TEXT DEFAULT 'off'"));
  assert(migration.includes("v_generation_id := v_file.active_generation_id"));
  assert(migration.includes("p_generation_id IS NOT NULL AND p_generation_id IS DISTINCT FROM v_generation_id"));
  for (const code of [
    "PACKAGE_PROFILE_MISSING",
    "PACKAGE_PROFILE_AMBIGUOUS",
    "PACKAGE_MEMBERSHIP_MISSING",
    "PACKAGE_MEMBERSHIP_AMBIGUOUS",
    "PACKAGE_RELATIONSHIP_MISSING",
    "PACKAGE_RELATIONSHIP_AMBIGUOUS",
    "PACKAGE_RESOLUTION_MISSING",
    "PACKAGE_RESOLUTION_FAILED",
    "PACKAGE_PROJECTION_MISSING",
    "PACKAGE_PROJECTION_FAILED",
    "PACKAGE_PROJECTION_STALE_GENERATION",
    "PACKAGE_COMPATIBILITY_NOT_PERSISTED",
    "PACKAGE_REQUIRED_CONFLICT_OPEN",
    "PACKAGE_REQUIRED_RELATED_DOCUMENT_MISSING",
    "PACKAGE_EFFECTIVE_CLAIM_INVALID",
    "PACKAGE_MODE_CONFIGURATION_INVALID",
  ]) {
    assert(migration.includes(code));
  }
  assert(migration.includes("app.allow_review_readiness_ready"));
  assert(migration.includes("review_readiness = 'ready'"));
});

Deno.test("P3.7 scope 66/67/68/69/70/71: runtime wiring is after P2, before finalizer, and does not touch providers/UI", () => {
  const claimsIndex = normalize.lastIndexOf("maybeRunClaimsLedgerForStage");
  const packageIndex = normalize.indexOf('if (packageMode !== "off" && jobGenerationId)');
  const finalizerIndex = normalize.indexOf("finalize_lease_extraction_for_review", packageIndex);
  assert(claimsIndex >= 0 && packageIndex > claimsIndex && finalizerIndex > packageIndex);
  assert(normalize.includes("packageMode !== \"off\""));
  assert(normalize.includes("p_package_mode: packageMode"));
  assert(worker.includes("p_package_mode: getLeaseDocumentPackageMode()"));
  assert(saveDraft.includes("package-active review draft saves must use package reviewer decision routes"));

  const runtime = Deno.readTextFileSync("supabase/functions/_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts");
  assert(!runtime.includes("fetch("));
  assert(!runtime.includes("Azure"));
  assert(!runtime.includes("Vertex"));
});
