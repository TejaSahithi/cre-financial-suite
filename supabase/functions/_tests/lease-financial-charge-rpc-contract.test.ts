import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migrationPath = "supabase/migrations/20260851000000_lease_financial_charge_candidates_p4_4.sql";
async function sql(): Promise<string> {
  return await Deno.readTextFile(migrationPath);
}

Deno.test("P4.4 SQL: creates immutable financial charge lanes and registry snapshot", async () => {
  const source = await sql();
  for (const table of [
    "lease_financial_charge_registry_snapshots",
    "lease_financial_charge_registry_entries",
    "lease_financial_charge_candidates",
    "lease_financial_charge_period_candidates",
    "lease_financial_charge_amounts",
    "lease_financial_deposit_components",
    "lease_financial_amortization_candidates",
    "lease_financial_formula_candidates",
    "lease_financial_charge_claim_links",
    "lease_financial_charge_conflicts",
    "lease_financial_charge_reviewer_decisions",
  ]) {
    assertStringIncludes(source, `CREATE TABLE public.${table}`);
    assertStringIncludes(source, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(source, `REVOKE ALL ON public.${table} FROM authenticated, anon`);
  }
  assertStringIncludes(source, "lease-financial-charges-v1");
  assertStringIncludes(source, "9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c");
});

Deno.test("P4.4 SQL: blocks deterministic calculations and runtime projections", async () => {
  const source = await sql();
  for (const forbidden of [
    "calculated_amount",
    "calculated_payment",
    "computed_cam",
    "recoverability_result",
    "allocated_expenses",
    "generated_periods",
    "expanded_periods",
    "due_dates",
    "critical_dates",
    "resolved_date",
    "calculated_percentage_rent",
    "computed_interest",
    "amortization_schedule",
    "gross_up_result",
    "reconciliation_result",
  ]) {
    assertStringIncludes(source, forbidden);
  }
  assertStringIncludes(source, "CHECK (base_rent_schedule_candidate_id IS NULL)");
  assertStringIncludes(source, "belongs_to_base_rent_schedules = false");
});

Deno.test("P4.4 SQL: persistence is service-role only and reviewer decisions are authenticated", async () => {
  const source = await sql();
  for (const fn of [
    "persist_lease_financial_charge_candidates",
    "persist_lease_financial_charge_period_candidates",
    "persist_lease_financial_charge_amounts",
    "persist_lease_financial_deposit_components",
    "persist_lease_financial_amortization_candidates",
    "persist_lease_financial_formula_candidates",
    "record_lease_financial_charge_review_decision",
  ]) {
    assertStringIncludes(source, `CREATE OR REPLACE FUNCTION public.${fn}`);
    assertStringIncludes(source, "SECURITY DEFINER");
    assertStringIncludes(source, "SET search_path = public, pg_temp");
  }
  assertStringIncludes(source, "SERVICE_ROLE_ONLY");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.persist_lease_financial_charge_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.record_lease_financial_charge_review_decision(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role");
  assertStringIncludes(source, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(source, "public.is_member_of_org(p_org_id)");
  assertStringIncludes(source, "UNIQUE (org_id, idempotency_key)");
  assertStringIncludes(source, "INSERT INTO public.audit_logs");
});

Deno.test("P4.4 SQL: migration does not mutate prior immutable phases or runtime outputs", async () => {
  const raw = await sql();
  const source = raw.replace(/^--.*$/gm, "");
  assertEquals(/UPDATE\s+public\.lease_claims/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_package_effective_claims/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_date_expressions/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_term_candidates/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_base_rent_/i.test(source), false);
  assertEquals(/extraction_data/i.test(source), false);
  assertEquals(/workflow_output/i.test(source), false);
  assertEquals(/finalize_lease_extraction_for_review/i.test(source), false);
  assertEquals(/parse-pdf-docling|normalize-pdf-output|ingest-file|business-extraction-provider/i.test(source), false);
  assertStringIncludes(raw, "LEASE_FINANCIAL_SCHEDULE_MODE");
});
