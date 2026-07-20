// @ts-nocheck
// P4.7 -- financial runtime orchestrator mode and RPC behavior.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  maybeRunLeaseFinancialScheduleRuntime,
  runLeaseFinancialScheduleRuntime,
  validateFinancialRuntimeModeCombination,
} from "../_shared/extraction/lease-financial-schedule/runtime/financial-runtime-orchestrator.ts";
import { FINANCIAL_RUNTIME_ERROR_CODES, FinancialRuntimeError } from "../_shared/extraction/lease-financial-schedule/runtime/financial-runtime-errors.ts";

function env(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] };
}

function modes(financialMode: string, claimsMode = "off", packageMode = "off") {
  return { financialMode, claimsMode, packageMode };
}

const runtimeEnv = (financialMode: string, claimsMode = "off", packageMode = "off") => env({
  LEASE_FINANCIAL_SCHEDULE_MODE: financialMode,
  LEASE_CLAIMS_LEDGER_MODE: claimsMode,
  LEASE_DOCUMENT_PACKAGE_MODE: packageMode,
});

const context = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  leaseId: "lease-1",
  extractionRunId: "run-1",
  generationId: "generation-1",
};

class QueryBuilder {
  result: any;
  constructor(result: any) {
    this.result = result;
  }
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return Promise.resolve(this.result); }
  then(resolve: (value: any) => void) { return Promise.resolve(this.result).then(resolve); }
}

function fakeSupabase(fixtures: Record<string, any[]>, rpcs: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    from(table: string) {
      calls.push({ kind: "from", table });
      const queue = fixtures[table] ?? [];
      const result = queue.length > 0 ? queue.shift() : { data: null, error: null };
      return new QueryBuilder(result);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, params });
      const result = rpcs[name] ?? { data: { success: true, status: "completed" }, error: null };
      return typeof result === "function" ? await result(params) : result;
    },
  };
}

Deno.test("P4.7 mode matrix: off no-ops before any Supabase call", async () => {
  const supabase = fakeSupabase({});
  const result = await maybeRunLeaseFinancialScheduleRuntime(supabase, context, {}, runtimeEnv("off"));
  assertEquals(result, { enabled: false, mode: "off", compatibilityPersisted: false, status: "disabled" });
  assertEquals(supabase.calls.length, 0);
});

Deno.test("P4.7 mode matrix: invalid dependency combinations fail explicitly", () => {
  const shadowWithoutClaims = (() => {
    try { validateFinancialRuntimeModeCombination(modes("shadow", "off", "off")); } catch (error) { return error; }
  })();
  assert(shadowWithoutClaims instanceof FinancialRuntimeError);
  assertEquals(shadowWithoutClaims.errorCode, FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER);

  const activeWithClaimsShadow = (() => {
    try { validateFinancialRuntimeModeCombination(modes("active", "shadow", "active")); } catch (error) { return error; }
  })();
  assert(activeWithClaimsShadow instanceof FinancialRuntimeError);
  assertEquals(activeWithClaimsShadow.errorCode, FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE);

  const activePackageAware = (() => {
    try { validateFinancialRuntimeModeCombination(modes("active", "active", "shadow"), { packageAwareInput: true }); } catch (error) { return error; }
  })();
  assert(activePackageAware instanceof FinancialRuntimeError);
  assertEquals(activePackageAware.errorCode, FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE);

  validateFinancialRuntimeModeCombination(modes("active", "active", "active"), { packageAwareInput: true });
  validateFinancialRuntimeModeCombination(modes("active", "active", "off"), { packageAwareInput: false });
});

Deno.test("P4.7 shadow failure remains visible but does not throw", async () => {
  const result = await maybeRunLeaseFinancialScheduleRuntime(null, context, {}, runtimeEnv("shadow", "shadow", "off"));
  assertEquals(result?.enabled, true);
  assertEquals(result?.mode, "shadow");
  assertEquals(result?.status, "failed");
  assertEquals(result?.compatibilityPersisted, false);
});

Deno.test("P4.7 active failure is not downgraded", async () => {
  await assertRejects(
    () => maybeRunLeaseFinancialScheduleRuntime(null, context, {}, runtimeEnv("active", "active", "off")),
  );
});

Deno.test("P4.7 shadow reuses current-generation calculation/projection without write-back", async () => {
  const supabase = fakeSupabase({
    extraction_runs: [{ data: { id: "run-1" }, error: null }],
    uploaded_files: [{ data: { id: "file-1", org_id: "org-1", active_generation_id: "generation-1" }, error: null }],
    lease_package_documents: [{ data: null, error: null }],
    lease_financial_calculation_runs: [{ data: { id: "calc-1", generation_id: "generation-1", status: "completed", blocking_issue_count: 0, validation_issue_count: 0 }, error: null }],
    lease_financial_projection_runs: [{ data: { id: "proj-1", generation_id: "generation-1", calculation_run_id: "calc-1", status: "completed", projection_version: "lease-financial-projection-v1", validation_codes: [], diff_count: 2 }, error: null }],
  });

  const result = await runLeaseFinancialScheduleRuntime(supabase, context, {}, runtimeEnv("shadow", "shadow", "off"));
  assertEquals(result.status, "completed_with_warnings");
  assertEquals(result.calculationRunId, "calc-1");
  assertEquals(result.projectionRunId, "proj-1");
  assertEquals(result.diffStatus, "recorded");
  assertEquals(result.compatibilityPersisted, false);
  assertEquals(result.criticalDateProjectionStatus, "candidate_only");
  assertEquals(supabase.calls.filter((call) => call.kind === "rpc").length, 0);
});

Deno.test("P4.7 active persists compatibility and projects critical dates through narrow RPCs", async () => {
  const supabase = fakeSupabase({
    extraction_runs: [{ data: { id: "run-1" }, error: null }],
    uploaded_files: [{ data: { id: "file-1", org_id: "org-1", active_generation_id: "generation-1" }, error: null }],
    lease_package_documents: [{ data: null, error: null }],
    lease_financial_calculation_runs: [{ data: { id: "calc-1", generation_id: "generation-1", status: "completed", blocking_issue_count: 0, validation_issue_count: 0 }, error: null }],
    lease_financial_projection_runs: [{ data: { id: "proj-1", generation_id: "generation-1", calculation_run_id: "calc-1", status: "completed", projection_version: "lease-financial-projection-v1", validation_codes: [], diff_count: 0 }, error: null }],
    lease_financial_field_projections: [{ data: [{ field_key: "monthly_rent", normalized_value_text: "6004.00", display_value: "$6,004", value_json: null, source_evidence: [{ claim_id: "claim-1" }] }], error: null }],
  }, {
    persist_lease_financial_projection: { data: { success: true, status: "completed" }, error: null },
    project_lease_financial_critical_dates: { data: { success: true, status: "completed" }, error: null },
  });

  const result = await runLeaseFinancialScheduleRuntime(supabase, context, {}, runtimeEnv("active", "active", "off"));
  assertEquals(result.status, "completed");
  assertEquals(result.compatibilityPersisted, true);
  assertEquals(result.criticalDateProjectionStatus, "completed");
  const rpcNames = supabase.calls.filter((call) => call.kind === "rpc").map((call) => call.name);
  assertEquals(rpcNames, ["persist_lease_financial_projection", "project_lease_financial_critical_dates"]);
  const write = supabase.calls.find((call) => call.name === "persist_lease_financial_projection");
  assertEquals(write.params.p_compatibility_patch.fields.monthly_rent.value, "6004.00");
});
