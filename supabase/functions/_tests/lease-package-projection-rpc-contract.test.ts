// @ts-nocheck
// P3.6 -- static contract guard for package projection persistence.

import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_PATH = "supabase/migrations/20260846000000_lease_package_projection_p3_6.sql";

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(SQL_PATH);
}

Deno.test("67/68: P3.6 migration adds package projection tables without reusing diagnostic v3 tables", async () => {
  const sql = await migrationSql();
  for (const table of [
    "lease_package_projection_runs",
    "lease_package_field_projections",
    "lease_package_projection_diffs",
  ]) {
    assertStringIncludes(sql, `CREATE TABLE public.${table}`);
    assertStringIncludes(sql, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
  }
  assert(!/CREATE\s+TABLE\s+public\.document_canonical_field_projections/i.test(sql));
  assert(!/CREATE\s+TABLE\s+public\.document_packages/i.test(sql));
});

Deno.test("43/44/45/46/47/48/50/58: persistence RPC validates completed resolution, idempotency, active package source claims and bounded diffs", async () => {
  const sql = await migrationSql();
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_package_projection");
  assertStringIncludes(sql, "SERVICE_ROLE_ONLY");
  assertStringIncludes(sql, "r.status = 'completed'");
  assertStringIncludes(sql, "idempotent_replay");
  assertStringIncludes(sql, "trg_enforce_lease_package_projection_claim_generation");
  assertStringIncludes(sql, "lpd.membership_status = 'confirmed'");
  assertStringIncludes(sql, "c.generation_id = uf.active_generation_id");
  assertStringIncludes(sql, "detailed_diff_artifact_id UUID");
  assertStringIncludes(sql, "octet_length(bounded_diff_summary::text) <= 20000");
});

Deno.test("61/62/63/64/65/66: migration never mutates runtime output, finalizer/readiness or P2/P3.5 source records", async () => {
  const sql = await migrationSql();
  const uncommentedSql = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert(!/UPDATE\s+public\.leases/i.test(sql));
  assert(!/extraction_data\s*=|workflow_output\s*=/i.test(sql));
  assert(!/UPDATE\s+public\.lease_claims|DELETE\s+FROM\s+public\.lease_claims/i.test(sql));
  assert(!/UPDATE\s+public\.lease_package_effective_claims|DELETE\s+FROM\s+public\.lease_package_effective_claims/i.test(sql));
  assert(!/review_readiness|finalizer|lease_extraction_finalizer/i.test(uncommentedSql));

  const runtimeFiles = [
    "supabase/functions/parse-pdf-docling/index.ts",
    "supabase/functions/normalize-pdf-output/index.ts",
    "supabase/functions/lease-extraction-worker/index.ts",
    "supabase/functions/approve-lease-workflow/index.ts",
  ];
  for (const file of runtimeFiles) {
    const content = await Deno.readTextFile(file);
    assert(!content.includes("projectPackageCompatibilityForResolution"));
    assert(!content.includes("persist_lease_package_projection"));
  }
});
