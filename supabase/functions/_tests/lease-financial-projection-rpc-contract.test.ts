import { assertEquals, assertStringIncludes, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migrationPath = "supabase/migrations/20260853000000_lease_financial_projection_results_p4_6.sql";
const read = () => Deno.readTextFile(migrationPath);

Deno.test("P4.6 SQL creates only immutable additive projection result tables", async () => {
  const source = await read();
  for (const table of [
    "lease_financial_projection_runs",
    "lease_financial_field_projections",
    "lease_financial_schedule_projections",
    "lease_financial_projection_diffs",
  ]) {
    assertStringIncludes(source, `CREATE TABLE public.${table}`);
    assertStringIncludes(source, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(source, `REVOKE ALL ON public.${table} FROM authenticated, anon`);
  }
  assertStringIncludes(source, "LEASE_FINANCIAL_PROJECTION_TERMINAL_RUNS_ARE_IMMUTABLE");
  assertStringIncludes(source, "LEASE_FINANCIAL_PROJECTION_RESULTS_ARE_IMMUTABLE");
  assertStringIncludes(source, "ON public.lease_financial_projection_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_financial_projection_run_terminal_immutability()");
  assertStringIncludes(source, "ON public.lease_financial_field_projections FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation()");
  assertStringIncludes(source, "ON public.lease_financial_schedule_projections FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation()");
  assertStringIncludes(source, "ON public.lease_financial_projection_diffs FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation()");
});

Deno.test("P4.6 SQL preserves reproducible identity, registry provenance and idempotent run identity", async () => {
  const source = await read();
  for (const token of [
    "projection_version TEXT NOT NULL CHECK (projection_version = 'lease-financial-projection-v1')",
    "compatibility_contract_version TEXT NOT NULL CHECK (compatibility_contract_version = 'lease-claims-v1')",
    "claims_registry_hash TEXT NOT NULL CHECK (claims_registry_hash = '4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a')",
    "date_registry_hash TEXT NOT NULL CHECK (date_registry_hash = '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8')",
    "charge_registry_hash TEXT NOT NULL CHECK (charge_registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c')",
    "calculation_version TEXT NOT NULL CHECK (calculation_version = 'lease-financial-calculation-v1')",
    "input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$')",
    "generation_identity TEXT NOT NULL",
    "UNIQUE (org_id, calculation_run_id, projection_version, input_hash)",
    "ON CONFLICT DO NOTHING RETURNING id INTO v_run_id",
  ]) assertStringIncludes(source, token);
});

Deno.test("P4.6 SQL RPCs are service-role-only, fixed search_path and project completed calculations only", async () => {
  const source = await read();
  for (const fn of [
    "start_lease_financial_projection_run",
    "persist_lease_financial_field_projections",
    "persist_lease_financial_schedule_projections",
    "persist_lease_financial_projection_diff",
    "settle_lease_financial_projection_run",
  ]) {
    assertStringIncludes(source, `CREATE OR REPLACE FUNCTION public.${fn}`);
    assertStringIncludes(source, "SECURITY DEFINER SET search_path = public, pg_temp");
    assertStringIncludes(source, "SERVICE_ROLE_ONLY");
  }
  assertStringIncludes(source, "IF v_calc.status NOT IN ('completed','completed_with_warnings') THEN RAISE EXCEPTION 'CALCULATION_RUN_NOT_PROJECTABLE'; END IF;");
  assertStringIncludes(source, "IF v_calc.generation_id <> p_generation_id THEN RAISE EXCEPTION 'GENERATION_MISMATCH'; END IF;");
  assertStringIncludes(source, "p_mode NOT IN ('off','shadow')");
  assertStringIncludes(source, "REVOKE ALL ON FUNCTION public.start_lease_financial_projection_run(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.start_lease_financial_projection_run(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role");
  assertEquals(source.includes("TO authenticated, service_role"), false);
});

Deno.test("P4.6 SQL uses composite foreign keys, scoped lease nulling, bounded json/arrays and no broad cascade", async () => {
  const source = await read();
  for (const token of [
    "FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT",
    "FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id)",
    "FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT",
    "octet_length(metadata::text) <= 20000",
    "array_length(validation_codes, 1) IS NULL OR array_length(validation_codes, 1) <= 100",
    "NOT (metadata ? 'raw_document_text')",
    "NOT (metadata ? 'provider_payload')",
  ]) assertStringIncludes(source, token);
  assertEquals(/ON DELETE CASCADE/i.test(source), false);
});

Deno.test("P4.6 SQL guardrails: no source mutation, current-output write, finalizer/readiness path or direct authenticated writes", async () => {
  const raw = await read();
  const source = raw.replace(/^--.*$/gm, "");
  for (const forbidden of [
    /UPDATE\s+public\.lease_date_expressions/i,
    /UPDATE\s+public\.lease_date_expression_dependencies/i,
    /UPDATE\s+public\.lease_term_candidates/i,
    /UPDATE\s+public\.lease_base_rent_.*_candidates/i,
    /UPDATE\s+public\.lease_financial_charge_.*_candidates/i,
    /INSERT\s+INTO\s+public\.lease_date_expressions/i,
    /extraction_data/i,
    /workflow_output/i,
    /critical_dates/i,
    /review_readiness/i,
    /finalize_lease_extraction_for_review/i,
    /GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON\s+public\.lease_financial_.*projection.*\s+TO\s+authenticated/i,
  ]) assertEquals(forbidden.test(source), false, String(forbidden));
  assertMatch(source, /CREATE TABLE public\.lease_financial_projection_runs/);
});