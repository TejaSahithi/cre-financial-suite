// @ts-nocheck
// P4.7 -- runtime SQL/RPC/finalizer/wiring contract tests.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migration = await Deno.readTextFile("supabase/migrations/20260854000000_lease_financial_runtime_p4_7.sql");
const normalize = await Deno.readTextFile("supabase/functions/normalize-pdf-output/index.ts");
const worker = await Deno.readTextFile("supabase/functions/lease-extraction-worker/index.ts");
const runtime = await Deno.readTextFile("supabase/functions/_shared/extraction/lease-financial-schedule/runtime/financial-runtime-orchestrator.ts");
const saveDraft = await Deno.readTextFile("supabase/functions/save-lease-review-draft/index.ts");
const updateField = await Deno.readTextFile("supabase/functions/update-lease-extraction-field/index.ts");

Deno.test("P4.7 migration: compatibility write-back RPC is narrow, service-owned, fenced and idempotent", () => {
  assertStringIncludes(migration, "CREATE TABLE public.lease_financial_compatibility_writes");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.persist_lease_financial_projection");
  assertStringIncludes(migration, "SECURITY DEFINER");
  assertStringIncludes(migration, "SET search_path = public, pg_temp");
  assertStringIncludes(migration, "IF auth.role() <> 'service_role' OR auth.uid() IS NOT NULL");
  assertStringIncludes(migration, "UNIQUE (org_id, idempotency_key)");
  assertStringIncludes(migration, "digest(p_compatibility_patch::text, 'sha256')");
  assertStringIncludes(migration, "idempotent_replay");
  assertStringIncludes(migration, "key NOT IN ('fields','field_evidence','confidence_scores')");
  for (const rejected of ["workflow_output", "raw_claims", "relationships", "provider_metadata", "artifact_path", "cam_profile", "expense_rules", "expenses", "budgets", "billing_rows", "rent_schedules", "financial_schedules", "raw_calculations", "calculation_results"]) {
    assertStringIncludes(migration, `'${rejected}'`);
  }
  for (const code of [
    "FINANCIAL_PROJECTION_WRITE_STALE_GENERATION",
    "FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH",
    "FINANCIAL_PROJECTION_WRITE_NOT_COMPLETED",
    "FINANCIAL_PROJECTION_WRITE_INVALID_PATCH",
    "FINANCIAL_PROJECTION_WRITE_TOO_LARGE",
    "FINANCIAL_PROJECTION_WRITE_APPROVED_LEASE",
    "FINANCIAL_PROJECTION_WRITE_IDEMPOTENCY_CONFLICT",
  ]) {
    assertStringIncludes(migration, code);
  }
  assert(!migration.includes("workflow_output ="));
});

Deno.test("P4.7 migration: critical-date projection is immutable candidate-only and approval lifecycle remains authoritative", () => {
  assertStringIncludes(migration, "CREATE TABLE public.lease_financial_critical_date_projections");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.project_lease_financial_critical_dates");
  assertStringIncludes(migration, "approval_lifecycle', 'candidate_only'");
  assertStringIncludes(migration, "resolved_date IS NOT NULL");
  assertStringIncludes(migration, "resolution_status IN ('extracted_fixed','resolved','calculated')");
  assertStringIncludes(migration, "validation_status IN ('valid','warning')");
  assert(!migration.includes("INSERT INTO public.critical_dates"));
  assert(!migration.includes("UPDATE public.critical_dates"));
});

Deno.test("P4.7 finalizer: one public financial-aware signature wraps the existing authoritative finalizer", () => {
  const creates = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.finalize_lease_extraction_for_review\(/g)].length;
  assertEquals(creates, 1);
  assertStringIncludes(migration, "ALTER FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) RENAME TO finalize_lease_extraction_for_review_p3_7");
  assertStringIncludes(migration, "p_financial_mode TEXT DEFAULT 'off'");
  assertStringIncludes(migration, "GRANT EXECUTE ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role");
  for (const code of [
    "FINANCIAL_MODE_CONFIGURATION_INVALID",
    "FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER",
    "FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE",
    "FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE",
    "FINANCIAL_CALCULATION_MISSING",
    "FINANCIAL_CALCULATION_FAILED",
    "FINANCIAL_CALCULATION_STALE_GENERATION",
    "FINANCIAL_PROJECTION_MISSING",
    "FINANCIAL_PROJECTION_FAILED",
    "FINANCIAL_PROJECTION_STALE_GENERATION",
    "FINANCIAL_COMPATIBILITY_NOT_PERSISTED",
    "FINANCIAL_REQUIRED_CONFLICT_OPEN",
    "FINANCIAL_REQUIRED_DATE_UNRESOLVED",
    "FINANCIAL_REQUIRED_TERM_UNRESOLVED",
    "FINANCIAL_REQUIRED_RENT_UNRESOLVED",
    "FINANCIAL_STATED_CALCULATED_MISMATCH",
    "FINANCIAL_REQUIRED_RELATED_DOCUMENT_MISSING",
    "FINANCIAL_CRITICAL_DATE_PROJECTION_INVALID",
  ]) {
    assertStringIncludes(migration, code);
  }
  assertStringIncludes(migration, "public.finalize_lease_extraction_for_review_p3_7");
});

Deno.test("P4.7 wiring: financial runtime is after package pipeline and before finalizer", () => {
  const packageIndex = normalize.indexOf("maybeRunLeaseDocumentPackagePipeline");
  const financialIndex = normalize.indexOf("maybeRunLeaseFinancialScheduleRuntime");
  const finalizerIndex = normalize.indexOf("finalize_lease_extraction_for_review", financialIndex);
  assert(packageIndex >= 0 && financialIndex > packageIndex && finalizerIndex > financialIndex);
  assertStringIncludes(normalize, "p_financial_mode: financialMode");
  assertStringIncludes(worker, "p_financial_mode: getLeaseFinancialScheduleMode()");
  assertStringIncludes(saveDraft, "financial-active review draft saves must use P4 reviewer decision routes");
  assertStringIncludes(updateField, "financial-active field edits must use P4 reviewer decision routes");
});

Deno.test("P4.7 scope: runtime has no provider/parser/frontend calls and active fields are bounded", () => {
  assert(!runtime.includes("fetch("));
  assert(!runtime.includes("Azure"));
  assert(!runtime.includes("Vertex"));
  assert(!runtime.includes("Docling"));
  for (const field of ["monthly_rent", "annual_rent", "security_deposit", "commencement_date", "expiration_date", "late_fee_amount", "assignment_consideration"]) {
    assertStringIncludes(migration, `'${field}'`);
    assertStringIncludes(updateField, `"${field}"`);
  }
});
