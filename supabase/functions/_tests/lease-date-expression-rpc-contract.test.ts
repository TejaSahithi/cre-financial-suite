// @ts-nocheck
// P4.1 -- SQL/RPC security, immutability and no-runtime-output contract tests.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_PATH = "supabase/migrations/20260848000000_lease_date_expression_foundation_p4_1.sql";
const sql = await Deno.readTextFile(SQL_PATH);
const uncommentedSql = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

Deno.test("P4.1 SQL: creates a separate immutable date-expression lane and registry snapshot", () => {
  for (const table of [
    "lease_date_expression_registry_versions",
    "lease_date_expression_types",
    "lease_date_expressions",
    "lease_date_expression_claim_links",
    "lease_date_expression_reviewer_decisions",
  ]) {
    assertStringIncludes(sql, `CREATE TABLE public.${table}`);
  }
  for (const table of [
    "lease_date_expressions",
    "lease_date_expression_claim_links",
    "lease_date_expression_reviewer_decisions",
  ]) {
    assertStringIncludes(sql, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
  }
  assertStringIncludes(sql, "registry_version TEXT NOT NULL DEFAULT 'lease-date-expressions-v1'");
  assertStringIncludes(sql, "registry_hash TEXT NOT NULL DEFAULT '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8'");
  assertEquals([...sql.matchAll(/\('lease-date-expressions-v1', '[a-z_]+',/g)].length, 12);
});

Deno.test("P4.1 SQL: expression structures prohibit fabricated date resolution", () => {
  assertStringIncludes(sql, "CHECK (offset_value IS NULL OR offset_value >= 0)");
  assertStringIncludes(sql, "CHECK (expression_type IN ('fixed_date', 'event_date') OR explicit_date IS NULL)");
  assertStringIncludes(sql, "expression_type = 'fixed_date' AND explicit_date IS NOT NULL");
  assertStringIncludes(sql, "expression_type <> 'relative_to_date' OR ((anchor_concept_key IS NOT NULL OR anchor_expression_id IS NOT NULL) AND offset_value IS NOT NULL");
  assertStringIncludes(sql, "expression_type <> 'recurring_deadline' OR (recurrence_definition IS NOT NULL");
  assertStringIncludes(sql, "expression_status <> 'ambiguous' OR explicit_date IS NULL");
});

Deno.test("P4.1 SQL: source-claim, package and generation provenance are fenced", () => {
  assertStringIncludes(sql, "FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages");
  assertStringIncludes(sql, "FOREIGN KEY (source_package_document_id, package_id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (source_package_effective_claim_id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims");
  assertStringIncludes(sql, "DATE_EXPRESSION_SOURCE_MISMATCH");
  assertStringIncludes(sql, "DATE_EXPRESSION_REGISTRY_MISMATCH");
});

Deno.test("P4.1 SQL: candidate rows and links are immutable with lease-deletion nulling only", () => {
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.enforce_lease_date_expression_immutability()");
  assertStringIncludes(sql, "OLD.lease_id IS NOT NULL");
  assertStringIncludes(sql, "NEW.lease_id IS NULL");
  assertStringIncludes(sql, "ON DELETE SET NULL (lease_id)");
  assertStringIncludes(sql, "ON DELETE SET NULL (anchor_expression_id)");
  assertStringIncludes(sql, "lease_date_expressions rows are immutable");
  assertStringIncludes(sql, "lease_date_expression_claim_links rows are immutable");
  assertStringIncludes(sql, "lease_date_expression_reviewer_decisions rows are append-only");
  assertStringIncludes(sql, "BEFORE UPDATE OR DELETE ON public.lease_date_expression_claim_links");
  assertStringIncludes(sql, "BEFORE UPDATE OR DELETE ON public.lease_date_expression_reviewer_decisions");
});

Deno.test("P4.1 SQL: RPCs are narrow, fixed-search-path and grant scoped", () => {
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_date_expression_candidates");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.record_lease_date_expression_review_decision");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assert(/SET search_path = public, pg_temp/i.test(sql));
  assertStringIncludes(sql, "IF auth.uid() IS NOT NULL THEN");
  assertStringIncludes(sql, "SERVICE_ROLE_ONLY");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.persist_lease_date_expression_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.record_lease_date_expression_review_decision(UUID, UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated, service_role");
  assertStringIncludes(sql, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(sql, "NOT_AUTHENTICATED");
  assertStringIncludes(sql, "ON CONFLICT (org_id, idempotency_key) DO NOTHING");
  assertStringIncludes(sql, "ON CONFLICT (org_id, expression_key) DO NOTHING");
});

Deno.test("P4.1 SQL: grants do not expose table writes or a second concept registry", () => {
  assert(!/GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON\s+public\.lease_date_/i.test(sql));
  assert(!/GRANT\s+SELECT\s+ON\s+public\.lease_date_.*\s+TO\s+authenticated/i.test(sql));
  assert(!/CREATE\s+TABLE\s+public\.lease_financial_concepts/i.test(sql));
  assert(!/CREATE\s+TABLE\s+public\.financial_schedule_concepts/i.test(sql));
  assertStringIncludes(sql, "concept_key TEXT NOT NULL");
  assertStringIncludes(sql, "REFERENCES public.lease_claims (id, org_id)");
});

Deno.test("P4.1 SQL: migration does not mutate P2/P3 claims, runtime output, finalizer or schedule tables", () => {
  assert(!/UPDATE\s+public\.lease_claims|DELETE\s+FROM\s+public\.lease_claims/i.test(uncommentedSql));
  assert(!/UPDATE\s+public\.lease_package_effective_claims|DELETE\s+FROM\s+public\.lease_package_effective_claims/i.test(uncommentedSql));
  assert(!/UPDATE\s+public\.leases\s+SET/i.test(uncommentedSql));
  assert(!/extraction_data\s*=|workflow_output\s*=/i.test(uncommentedSql));
  assert(!/finalize_lease_extraction_for_review|review_readiness|lease_extraction_finalizer/i.test(uncommentedSql));
  assert(!/CREATE\s+TABLE\s+public\.lease_(rent|financial)_schedules/i.test(uncommentedSql));
  assert(!/CREATE\s+TABLE\s+public\.lease_critical_dates/i.test(uncommentedSql));
});

Deno.test("P4.1 SQL: new function and migration names stay inside P4.1 boundaries", () => {
  assertStringIncludes(sql, "DATE_EXPRESSION_SOURCE_CLAIM_MISSING");
  assertStringIncludes(sql, "DATE_EXPRESSION_SOURCE_MISMATCH");
  assertStringIncludes(sql, "DATE_EXPRESSION_TYPE_INVALID");
  assertStringIncludes(sql, "REPLACEMENT_EXPRESSION_REQUIRED");
  assert(!sql.includes("calculate_rent"));
  assert(!sql.includes("critical_date"));
  assert(!sql.includes("term_graph"));
});
