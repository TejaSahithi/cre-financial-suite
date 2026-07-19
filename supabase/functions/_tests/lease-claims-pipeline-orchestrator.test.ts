// @ts-nocheck
// P2.7 -- claims-pipeline-orchestrator.ts tests, with a mocked
// service-role client (same mocking approach as the P1 recorder tests:
// stub .rpc() and .from() rather than hitting a real database).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runClaimsLedgerForStage, maybeRunClaimsLedgerForStage } from "../_shared/extraction/claims/claims-pipeline-orchestrator.ts";

function fakeEnv(mode: string | undefined) {
  return { get: (key: string) => (key === "LEASE_CLAIMS_LEDGER_MODE" ? mode : undefined) };
}

const CONTEXT = {
  orgId: "org-1", uploadedFileId: "file-1", leaseId: null,
  extractionRunId: "run-1", extractionStageRunId: "stage-1",
  generationId: "gen-1", stageAttempt: 1,
};

function makeMockSupabase(overrides: Partial<Record<string, unknown>> = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const defaultRpcResponses: Record<string, unknown> = {
    persist_lease_claim_ledger_batch: { success: true, claims_inserted: 1, claim_id_map: {}, evidence_id_map: {} },
    detect_and_persist_claim_conflicts: { success: true, groups_created: 0 },
    persist_lease_claim_projection: { success: true, projection_run_id: "proj-1" },
    ...overrides,
  };
  return {
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      const response = defaultRpcResponses[name];
      return Promise.resolve({ data: response, error: null });
    },
    from(table: string) {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        then(resolve: (v: unknown) => unknown) {
          if (table === "lease_claims") {
            return resolve({
              data: [{ id: "c1", concept_key: "tenant_name", scope_key: "lease", instance_key: "default", producer_type: "deterministic_mapper", assertion_status: "asserted", normalized_value: "Acme Corp", raw_value_text: "Acme Corp", confidence: 90, created_at: "2026-01-01" }],
              error: null,
            });
          }
          if (table === "lease_claim_evidence_links") return resolve({ data: [{ claim_id: "c1" }], error: null });
          if (table === "lease_claim_conflict_groups") return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        },
      };
    },
    _rpcCalls: rpcCalls,
  };
}

Deno.test("orchestrator: mode 'off' no-ops entirely -- zero RPC calls, returns immediately", async () => {
  const mock = makeMockSupabase();
  const result = await runClaimsLedgerForStage(mock, CONTEXT, {
    deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [],
  }, fakeEnv("off"));
  assertEquals(result.mode, "off");
  assertEquals(result.ranClaimsLedger, false);
  assertEquals(mock._rpcCalls.length, 0);
});

Deno.test("orchestrator: mode 'shadow' persists claims, detects conflicts, persists projection, and returns a diff", async () => {
  const mock = makeMockSupabase();
  const result = await runClaimsLedgerForStage(mock, CONTEXT, {
    deterministicFields: { tenant_name: { value: "Acme Corp", source: "rule", confidence: 0.9, sourceText: "Tenant: Acme Corp", sourcePage: 1 } },
    semanticCandidateGroups: [],
    unmappedLlmFields: [],
    legacyExtractionData: { fields: { tenant_name: { value: "Acme Corp", extraction_status: "extracted" } } },
  }, fakeEnv("shadow"));

  assertEquals(result.mode, "shadow");
  assert(result.ranClaimsLedger);
  const calledNames = mock._rpcCalls.map((c) => c.name);
  assert(calledNames.includes("persist_lease_claim_ledger_batch"));
  assert(calledNames.includes("detect_and_persist_claim_conflicts"));
  assert(calledNames.includes("persist_lease_claim_projection"));
  assert(result.diff);
  assert(result.compatibilitySlice);
});

Deno.test("orchestrator: mode 'active' persists a projection too, but does not compute a diff", async () => {
  const mock = makeMockSupabase();
  const result = await runClaimsLedgerForStage(mock, CONTEXT, {
    deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [],
  }, fakeEnv("active"));
  assertEquals(result.mode, "active");
  assert(mock._rpcCalls.some((c) => c.name === "persist_lease_claim_projection"));
  assertEquals(result.diff, undefined);
});

Deno.test("orchestrator: a failed batch RPC throws rather than silently continuing", async () => {
  const mock = makeMockSupabase({ persist_lease_claim_ledger_batch: { success: false, error_code: "STALE_GENERATION" } });
  let threw = false;
  try {
    await runClaimsLedgerForStage(mock, CONTEXT, { deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [] }, fakeEnv("shadow"));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("maybeRunClaimsLedgerForStage: never throws even when the underlying call fails -- returns null instead", async () => {
  const mock = makeMockSupabase({ persist_lease_claim_ledger_batch: { success: false, error_code: "STALE_GENERATION" } });
  const result = await maybeRunClaimsLedgerForStage(mock, CONTEXT, { deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [] }, fakeEnv("shadow"));
  assertEquals(result, null);
});

Deno.test("maybeRunClaimsLedgerForStage: returns the real result when nothing fails", async () => {
  const mock = makeMockSupabase();
  const result = await maybeRunClaimsLedgerForStage(mock, CONTEXT, { deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [] }, fakeEnv("off"));
  assertEquals(result?.mode, "off");
});
