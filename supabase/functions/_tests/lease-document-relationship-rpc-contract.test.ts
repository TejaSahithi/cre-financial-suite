// @ts-nocheck
// P3.4 -- static contract guard for the relationship persistence/reviewer RPCs.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_PATH = "supabase/migrations/20260844000000_lease_document_relationship_detection_p3_4.sql";

async function migrationSql() {
  return await Deno.readTextFile(SQL_PATH);
}

Deno.test("62: P3.4 migration adds bounded detector batch RPC and reviewer decision RPC", async () => {
  const sql = await migrationSql();
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_document_relationship_candidates");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.resolve_lease_document_relationship_decision");
  assertStringIncludes(sql, "CREATE TABLE public.lease_document_relationship_reviewer_decisions");
});

Deno.test("43/44/45/48/49/50/51: reviewer RPC supports required operations, auth-derived identity, audit, stale guard and idempotency", async () => {
  const sql = await migrationSql();
  for (const operation of ["confirm", "reject", "select_target", "mark_requires_related_document", "reopen", "confirm_supersedes", "waive_related_document_requirement"]) {
    assertStringIncludes(sql, operation);
  }
  assertStringIncludes(sql, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(sql, "NOT_AUTHENTICATED");
  assertStringIncludes(sql, "NOT_ORG_MEMBER");
  assertStringIncludes(sql, "idempotency_key");
  assertStringIncludes(sql, "idempotent_replay");
  assertStringIncludes(sql, "STALE_GENERATION");
  assertStringIncludes(sql, "INSERT INTO public.audit_logs");
});

Deno.test("32/33/34/35/36/38/39/40: persistence RPC validates package/source/target/evidence and idempotently preserves candidates", async () => {
  const sql = await migrationSql();
  for (const code of [
    "SERVICE_ROLE_ONLY",
    "SOURCE_NOT_IN_PACKAGE",
    "TARGET_NOT_IN_PACKAGE",
    "SELF_RELATIONSHIP",
    "SOURCE_GENERATION_STALE",
    "EVIDENCE_GENERATION_MISMATCH",
    "EVIDENCE_CLAIM_NOT_FOUND",
  ]) {
    assertStringIncludes(sql, code);
  }
  assertStringIncludes(sql, "ON CONFLICT (org_id, relationship_key) DO NOTHING");
  assertStringIncludes(sql, "relationships_already_existed");
  assertStringIncludes(sql, "candidate_target_document_ids");
  assertStringIncludes(sql, "dynamic_evidence_claim_ids");
});

Deno.test("57/58: migration does not add pipeline call sites or mutate P2 claims", async () => {
  const sql = await migrationSql();
  assertEquals(sql.includes("normalize-pdf-output"), false);
  assertEquals(sql.includes("lease-extraction-worker"), false);
  assertEquals(sql.includes("UPDATE public.lease_claims"), false);
  assertEquals(sql.includes("DELETE FROM public.lease_claims"), false);
});
