// @ts-nocheck
// P4.2 -- SQL/RPC security, immutability and no-resolution contract tests.

import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_PATH = "supabase/migrations/20260849000000_lease_date_dependency_and_term_candidates_p4_2.sql";
const sql = await Deno.readTextFile(SQL_PATH);
const uncommentedSql = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

Deno.test("P4.2 SQL: creates separate immutable dependency and term lanes with RLS-select-only", () => {
  for (const table of [
    "lease_date_expression_dependencies",
    "lease_date_dependency_reviewer_decisions",
    "lease_term_candidates",
    "lease_term_reviewer_decisions",
  ]) {
    assertStringIncludes(sql, `CREATE TABLE public.${table}`);
    assertStringIncludes(sql, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(sql, `REVOKE ALL ON public.${table} FROM authenticated, anon`);
  }
  assert(!/GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON\s+public\.lease_(date_expression_dependencies|date_dependency_reviewer_decisions|term_candidates|term_reviewer_decisions)/i.test(sql));
});

Deno.test("P4.2 SQL: dependency graph vocabulary, direction and cycle fences are explicit", () => {
  for (const type of [
    "anchor",
    "offset_anchor",
    "event_anchor",
    "alternative",
    "condition",
    "minimum_operand",
    "maximum_operand",
    "earlier_of_operand",
    "later_of_operand",
    "recurrence_anchor",
    "notice_anchor",
    "term_start",
    "term_end",
    "resolves",
    "supersedes_expression",
    "contextual",
  ]) assertStringIncludes(sql, `'${type}'`);
  assertStringIncludes(sql, "source_expression_id UUID NOT NULL");
  assertStringIncludes(sql, "target_expression_id UUID");
  assertStringIncludes(sql, "CHECK (source_expression_id IS DISTINCT FROM target_expression_id)");
  assertStringIncludes(sql, "DATE_DEPENDENCY_CYCLE");
  assertStringIncludes(sql, "WITH RECURSIVE dependency_path");
  assertStringIncludes(sql, "dependency_type NOT IN ('minimum_operand', 'maximum_operand', 'earlier_of_operand', 'later_of_operand', 'alternative') OR operand_order IS NOT NULL");
});

Deno.test("P4.2 SQL: term candidates preserve expressions and durations but forbid resolved-date outputs", () => {
  for (const type of [
    "initial_term",
    "extension_term",
    "renewal_term",
    "option_term",
    "holdover_term",
    "construction_period",
    "rent_free_period",
    "partial_term",
    "unknown_term",
  ]) assertStringIncludes(sql, `'${type}'`);
  assertStringIncludes(sql, "start_expression_id UUID");
  assertStringIncludes(sql, "end_expression_id UUID");
  assertStringIncludes(sql, "duration_value NUMERIC");
  assertStringIncludes(sql, "duration_unit TEXT");
  assertStringIncludes(sql, "CHECK (NOT (metadata ? 'resolved_date'))");
  assertStringIncludes(sql, "CHECK (NOT (metadata ? 'rent_schedule'))");
  assertStringIncludes(sql, "CHECK (NOT (metadata ? 'critical_dates'))");
});

Deno.test("P4.2 SQL: provenance is fenced to org/package/file/run/generation and P2/P3 sources", () => {
  assertStringIncludes(sql, "FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)");
  assertStringIncludes(sql, "FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages");
  assertStringIncludes(sql, "FOREIGN KEY (source_expression_id, org_id) REFERENCES public.lease_date_expressions");
  assertStringIncludes(sql, "FOREIGN KEY (target_expression_id, org_id) REFERENCES public.lease_date_expressions");
  assertStringIncludes(sql, "FOREIGN KEY (source_package_effective_claim_id, org_id)");
  assertStringIncludes(sql, "REFERENCES public.lease_package_effective_claims");
  assertStringIncludes(sql, "FOREIGN KEY (related_document_requirement_id, org_id)");
  assertStringIncludes(sql, "REFERENCES public.lease_related_document_requirements");
  assertStringIncludes(sql, "DATE_DEPENDENCY_CONTEXT_MISMATCH");
  assertStringIncludes(sql, "LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH");
  assertStringIncludes(sql, "STALE_GENERATION");
});

Deno.test("P4.2 SQL: RPCs are narrow, service-role persistence plus authenticated reviewer decisions", () => {
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_date_expression_dependencies");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.persist_lease_term_candidates");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.record_lease_date_dependency_review_decision");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.record_lease_term_review_decision");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assert(/SET search_path = public, pg_temp/i.test(sql));
  assertStringIncludes(sql, "IF auth.uid() IS NOT NULL THEN");
  assertStringIncludes(sql, "SERVICE_ROLE_ONLY");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.persist_lease_date_expression_dependencies(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.persist_lease_term_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.record_lease_date_dependency_review_decision(UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.record_lease_term_review_decision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role");
  assertStringIncludes(sql, "v_actor_user_id UUID := auth.uid()");
  assertStringIncludes(sql, "NOT_AUTHENTICATED");
  assertStringIncludes(sql, "NOT_ORG_MEMBER");
  assertStringIncludes(sql, "ON CONFLICT (org_id, idempotency_key) DO NOTHING");
  assertStringIncludes(sql, "INSERT INTO public.audit_logs");
});

Deno.test("P4.2 SQL: reviewer decisions are append-only and support required operations", () => {
  for (const operation of ["accept", "reject", "replace", "mark_requires_related_document", "reopen"]) {
    assertStringIncludes(sql, `'${operation}'`);
  }
  assertStringIncludes(sql, "'select_ambiguous_anchor'");
  assertStringIncludes(sql, "lease_date_dependency_reviewer_decisions rows are append-only");
  assertStringIncludes(sql, "lease_term_reviewer_decisions rows are append-only");
  assertStringIncludes(sql, "BEFORE UPDATE OR DELETE ON public.lease_date_dependency_reviewer_decisions");
  assertStringIncludes(sql, "BEFORE UPDATE OR DELETE ON public.lease_term_reviewer_decisions");
});

Deno.test("P4.2 SQL: migration does not mutate P2/P3/P4.1 sources or runtime outputs", () => {
  assert(!/UPDATE\s+public\.lease_claims|DELETE\s+FROM\s+public\.lease_claims/i.test(uncommentedSql));
  assert(!/UPDATE\s+public\.lease_package_effective_claims|DELETE\s+FROM\s+public\.lease_package_effective_claims/i.test(uncommentedSql));
  assert(!/UPDATE\s+public\.lease_date_expressions|DELETE\s+FROM\s+public\.lease_date_expressions/i.test(uncommentedSql));
  assert(!/UPDATE\s+public\.leases\s+SET/i.test(uncommentedSql));
  assert(!/extraction_data\s*=|workflow_output\s*=/i.test(uncommentedSql));
  assert(!/finalize_lease_extraction_for_review|review_readiness|lease_extraction_finalizer/i.test(uncommentedSql));
  assert(!/CREATE\s+TABLE\s+public\.lease_(rent|financial)_schedules/i.test(uncommentedSql));
  assert(!/CREATE\s+TABLE\s+public\.lease_critical_dates/i.test(uncommentedSql));
  assert(!/calculate_rent|expand_recurring|resolve_commencement|resolve_expiration/i.test(uncommentedSql));
});
