import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migrationPath = "supabase/migrations/20260852000000_lease_financial_calculation_results_p4_5.sql";
const read = () => Deno.readTextFile(migrationPath);

Deno.test("P4.5 SQL 60-70,91-92: calculation run preserves reproducible version/hash/generation/input identity", async () => {
  const source = await read();
  for (const token of [
    "CREATE TABLE public.lease_financial_calculation_runs",
    "calculation_version TEXT NOT NULL CHECK (calculation_version = 'lease-financial-calculation-v1')",
    "date_engine_version TEXT NOT NULL CHECK (date_engine_version = 'lease-date-resolution-engine-v1')",
    "term_engine_version TEXT NOT NULL CHECK (term_engine_version = 'lease-term-resolution-engine-v1')",
    "rent_engine_version TEXT NOT NULL CHECK (rent_engine_version = 'lease-rent-calculation-engine-v1')",
    "charge_engine_version TEXT NOT NULL CHECK (charge_engine_version = 'lease-charge-calculation-engine-v1')",
    "claims_registry_version TEXT NOT NULL CHECK (claims_registry_version = 'lease-claims-v1')",
    "4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a",
    "lease-date-expressions-v1",
    "4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8",
    "lease-financial-charges-v1",
    "9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c",
    "input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$')",
    "CREATE UNIQUE INDEX lease_financial_calculation_runs_idempotent_idx ON public.lease_financial_calculation_runs (org_id, COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid), generation_id, calculation_version, input_hash)",
    "ON CONFLICT DO NOTHING RETURNING id INTO v_run_id",
    "package_id IS NOT DISTINCT FROM p_package_id",
  ]) assertStringIncludes(source, token);
  assertEquals(source.includes("UNIQUE (org_id, package_id, generation_id, calculation_version, input_hash)"), false);
});

Deno.test("P4.5 SQL: every calculated value lives in a new immutable result table", async () => {
  const source = await read();
  for (const table of [
    "lease_date_resolution_results",
    "lease_term_resolution_results",
    "lease_base_rent_calculation_results",
    "lease_base_rent_calculated_periods",
    "lease_base_rent_calculated_amounts",
    "lease_financial_charge_calculation_results",
    "lease_financial_formula_evaluation_results",
    "lease_financial_amortization_results",
    "lease_financial_validation_issues",
    "lease_financial_calculation_review_decisions",
  ]) {
    assertStringIncludes(source, `CREATE TABLE public.${table}`);
    assertStringIncludes(source, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(source, `REVOKE ALL ON public.${table} FROM authenticated, anon`);
    assertStringIncludes(source, `ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation()`);
  }
  assertStringIncludes(source, "LEASE_FINANCIAL_CALCULATION_TERMINAL_RUNS_ARE_IMMUTABLE");
});

Deno.test("P4.5 SQL 71-79: RPC/security contract is service-role persistence plus auth.uid reviewer audit", async () => {
  const source = await read();
  for (const fn of [
    "start_lease_financial_calculation_run",
    "persist_lease_date_resolution_results",
    "persist_lease_term_resolution_results",
    "persist_lease_rent_calculation_results",
    "persist_lease_financial_charge_calculation_results",
    "settle_lease_financial_calculation_run",
    "record_lease_financial_calculation_review_decision",
  ]) {
    assertStringIncludes(source, `CREATE OR REPLACE FUNCTION public.${fn}`);
    assertStringIncludes(source, "SECURITY DEFINER SET search_path = public, pg_temp");
  }
  assertStringIncludes(source, "SERVICE_ROLE_ONLY");
  assertStringIncludes(source, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(source, "public.is_member_of_org(p_org_id)");
  assertStringIncludes(source, "UNIQUE (org_id, idempotency_key)");
  assertStringIncludes(source, "INSERT INTO public.audit_logs");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.record_lease_financial_calculation_review_decision(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated, service_role");
});

Deno.test("P4.5 SQL guardrails: no source mutation, no current-output writes, no broad cascade and no direct authenticated writes", async () => {
  const raw = await read();
  const source = raw.replace(/^--.*$/gm, "");
  for (const forbidden of [
    /UPDATE\s+public\.lease_date_expressions/i,
    /UPDATE\s+public\.lease_date_expression_dependencies/i,
    /UPDATE\s+public\.lease_term_candidates/i,
    /UPDATE\s+public\.lease_base_rent_.*_candidates/i,
    /UPDATE\s+public\.lease_financial_charge_.*_candidates/i,
    /UPDATE\s+public\.lease_claims/i,
    /UPDATE\s+public\.lease_package_effective_claims/i,
    /INSERT\s+INTO\s+public\.lease_critical_dates/i,
    /extraction_data/i,
    /workflow_output/i,
    /finalize_lease_extraction_for_review/i,
  ]) assertEquals(forbidden.test(source), false);
  assertEquals(/GRANT\s+(INSERT|UPDATE|DELETE).*authenticated/i.test(source), false);
  assertStringIncludes(source, "ON DELETE SET NULL (lease_id)");
  assertStringIncludes(source, "ON DELETE RESTRICT");
});

Deno.test("P4.5 SQL scope 80-90,103-105: passive feature mode and bounded metadata remain explicit", async () => {
  const source = await read();
  assertStringIncludes(source, "mode TEXT NOT NULL CHECK (mode IN ('off','shadow','active'))");
  assertStringIncludes(source, "octet_length(metadata::text) <= 20000");
  assertStringIncludes(source, "array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100");
  assertStringIncludes(source, "CHECK (amount_role <> 'billed_first_year_rent' OR calculation_type <> 'annualized_reference')");
  assertEquals(/cam_allocation|recoverability_result|expense_rules|provider_payload_url|sales_fetch|cpi_fetch/i.test(source), false);
});