// @ts-nocheck
// P3.5 -- static contract guard for package-resolution persistence/reviewer RPCs.

import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_PATH = "supabase/migrations/20260845000000_lease_package_resolution_p3_5.sql";

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(SQL_PATH);
}

Deno.test("66/67: P3.5 migration adds authoritative resolution tables without reusing diagnostic v3 tables", async () => {
  const sql = await migrationSql();
  for (const table of [
    "lease_package_resolution_runs",
    "lease_package_effective_claims",
    "lease_package_claim_overrides",
    "lease_package_resolution_conflicts",
    "lease_package_resolution_reviewer_decisions",
  ]) {
    assertStringIncludes(sql, `CREATE TABLE public.${table}`);
    assertStringIncludes(sql, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
  }
  assert(!/CREATE\s+TABLE\s+public\.document_canonical_field_projections/i.test(sql));
  assert(!/CREATE\s+TABLE\s+public\.document_packages/i.test(sql));
});

Deno.test("54/55/56/57/58: reviewer conflict RPC derives identity, checks org membership, idempotency, stale/foreign claim selection and audit", async () => {
  const sql = await migrationSql();
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.resolve_lease_package_claim_conflict");
  assertStringIncludes(sql, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(sql, "NOT public.is_member_of_org(p_org_id)");
  assertStringIncludes(sql, "idempotency_key = p_idempotency_key");
  assertStringIncludes(sql, "SELECTED_CLAIM_NOT_ACTIVE_IN_PACKAGE");
  assertStringIncludes(sql, "c.generation_id = uf.active_generation_id");
  assertStringIncludes(sql, "INSERT INTO public.audit_logs");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.resolve_lease_package_claim_conflict");
});

Deno.test("44/45/46/47/48/49/50: persistence RPC fences selected claims to active package/org generations and keeps source claims immutable", async () => {
  const sql = await migrationSql();
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_package_resolution");
  assertStringIncludes(sql, "SERVICE_ROLE_ONLY");
  assertStringIncludes(sql, "trg_enforce_lease_package_resolution_claim_generation");
  assertStringIncludes(sql, "lpd.membership_status = 'confirmed'");
  assertStringIncludes(sql, "c.generation_id = uf.active_generation_id");
  assertStringIncludes(sql, "FOREIGN KEY (selected_source_claim_id, org_id) REFERENCES public.lease_claims");
  assertStringIncludes(sql, "FOREIGN KEY (source_relationship_id, org_id) REFERENCES public.lease_document_relationships");
  assert(!/UPDATE\s+public\.lease_claims/i.test(sql));
  assert(!/DELETE\s+FROM\s+public\.lease_claims/i.test(sql));
});

Deno.test("61/62/63/64/65: migration does not add runtime pipeline call sites or compatibility projection mutation", async () => {
  const sql = await migrationSql();
  assert(!/extraction_data\s*=|workflow_output\s*=|UPDATE\s+public\.leases/i.test(sql));
  assert(!/document_canonical_field_projections|lease_claim_projections|buildCompatibility|compatibility_payload/i.test(sql));

  const runtimeFiles = [
    "supabase/functions/parse-pdf-docling/index.ts",
    "supabase/functions/normalize-pdf-output/index.ts",
    "supabase/functions/lease-extraction-worker/index.ts",
    "supabase/functions/approve-lease-workflow/index.ts",
  ];
  for (const file of runtimeFiles) {
    const content = await Deno.readTextFile(file);
    assert(!content.includes("resolvePackageClaimsForPackage"));
    assert(!content.includes("persist_lease_package_resolution"));
  }
});
