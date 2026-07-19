import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migrationPath = "supabase/migrations/20260850000000_lease_base_rent_schedule_candidates_p4_3.sql";

async function sql(): Promise<string> {
  return await Deno.readTextFile(migrationPath);
}

Deno.test("P4.3 SQL: creates separate immutable base-rent schedule, period, amount and escalation lanes", async () => {
  const source = await sql();
  for (const table of [
    "lease_base_rent_schedule_candidates",
    "lease_base_rent_period_candidates",
    "lease_base_rent_period_amounts",
    "lease_base_rent_escalation_candidates",
    "lease_base_rent_schedule_claim_links",
    "lease_base_rent_schedule_conflicts",
    "lease_base_rent_reviewer_decisions",
  ]) {
    assertStringIncludes(source, `CREATE TABLE public.${table}`);
    assertStringIncludes(source, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(source, `REVOKE ALL ON public.${table} FROM authenticated, anon`);
  }
  assertStringIncludes(source, "lease-base-rent-schedules-v1");
  assertStringIncludes(source, "lease-base-rent-periods-v1");
  assertStringIncludes(source, "lease-base-rent-amounts-v1");
  assertStringIncludes(source, "lease-base-rent-escalations-v1");
});

Deno.test("P4.3 SQL: monetary and date calculation outputs are explicitly blocked", async () => {
  const source = await sql();
  for (const forbidden of [
    "calculated_monthly_rent",
    "calculated_annual_rent",
    "converted_psf_rent",
    "resolved_date",
    "generated_periods",
    "expanded_periods",
    "critical_dates",
    "prorated_amount",
    "cpi_value",
  ]) {
    assertStringIncludes(source, forbidden);
  }
  assertStringIncludes(source, "NOT (amount_role = 'billed_base_rent' AND amount_basis = 'per_year')");
  assertStringIncludes(source, "amount_role <> 'annualized_reference' OR amount_basis = 'per_year'");
  assertStringIncludes(source, "amount_role <> 'stated_psf_rate' OR amount_basis IN ('per_square_foot_per_year', 'per_square_foot_per_month')");
});

Deno.test("P4.3 SQL: RPCs are service-role persistence plus authenticated reviewer decisions", async () => {
  const source = await sql();
  for (const fn of [
    "persist_lease_base_rent_schedule_candidates",
    "persist_lease_base_rent_period_candidates",
    "persist_lease_base_rent_period_amounts",
    "persist_lease_base_rent_escalation_candidates",
    "record_lease_base_rent_review_decision",
  ]) {
    assertStringIncludes(source, `CREATE OR REPLACE FUNCTION public.${fn}`);
    assertStringIncludes(source, "SECURITY DEFINER");
    assertStringIncludes(source, "SET search_path = public, pg_temp");
  }
  assertStringIncludes(source, "SERVICE_ROLE_ONLY");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_schedule_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_period_candidates(UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_period_amounts(UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_escalation_candidates(UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(source, "GRANT EXECUTE ON FUNCTION public.record_lease_base_rent_review_decision(UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role");
});

Deno.test("P4.3 SQL: reviewer operations are append-only, audited, idempotent and auth.uid-derived", async () => {
  const source = await sql();
  for (const operation of [
    "accept_schedule",
    "reject_schedule",
    "replace_schedule",
    "accept_period",
    "reject_period",
    "correct_period_boundaries",
    "classify_annualized_vs_billed",
    "select_conflicting_amount",
    "mark_schedule_incomplete",
    "mark_requires_related_document",
    "reopen",
  ]) {
    assertStringIncludes(source, operation);
  }
  assertStringIncludes(source, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(source, "public.is_member_of_org(p_org_id)");
  assertStringIncludes(source, "UNIQUE (org_id, idempotency_key)");
  assertStringIncludes(source, "INSERT INTO public.audit_logs");
  assertStringIncludes(source, "STALE_GENERATION");
});

Deno.test("P4.3 SQL: migration does not mutate prior phases, runtime output, finalizer or legacy rent schedule tables", async () => {
  const source = (await sql()).replace(/^--.*$/gm, "");
  assertEquals(/UPDATE\s+public\.lease_claims/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_package_effective_claims/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_date_expressions/i.test(source), false);
  assertEquals(/UPDATE\s+public\.lease_term_candidates/i.test(source), false);
  assertEquals(/extraction_data/i.test(source), false);
  assertEquals(/workflow_output/i.test(source), false);
  assertEquals(/finalize_lease_extraction_for_review/i.test(source), false);
  assertEquals(/INSERT\s+INTO\s+public\.rent_schedules/i.test(source), false);
  assertEquals(/INSERT\s+INTO\s+public\.lease_critical_dates/i.test(source), false);
});

Deno.test("P4.3 SQL: feature mode remains the existing financial schedule flag and no new mode is introduced", async () => {
  const source = await sql();
  assertStringIncludes(source, "LEASE_FINANCIAL_SCHEDULE_MODE");
  assertEquals(/BASE_RENT_[A-Z_]*MODE/.test(source), false);
  assertEquals(/parse-pdf-docling|normalize-pdf-output|ingest-file|business-extraction-provider/i.test(source), false);
});
