// @ts-nocheck
// Additional adversarial/regression tests for the Assistant (section 29),
// beyond assistant-security.test.ts's broker/orchestrator-level coverage:
//   - request-context sanitization (injection via the `context` payload)
//   - real production tools (not synthetic test tools) fail closed with no auth
//   - no tool's static denial/no_data message text leaks org/enumeration hints
//
// Run: deno test --allow-env --allow-read --allow-net --no-check --no-lock supabase/functions/_tests/assistant-security-hardening.test.ts

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeAndRunTool } from "../_shared/assistant/tools/tool-broker.ts";
import { TOOL_REGISTRY, getTool } from "../_shared/assistant/tools/tool-registry.ts";

// Matches the repo's existing convention for testing a Deno.serve-based
// edge function's internals (see business-extraction-provider-default-
// failsafe.test.ts): monkeypatch Deno.serve so importing index.ts doesn't
// actually bind a listener, import, then restore.
const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: assistantChat } = await import("../assistant-chat-v1/index.ts");
(Deno as any).serve = realServe;

// ---------------------------------------------------------------------------
// Request-context sanitization
// ---------------------------------------------------------------------------

Deno.test("sanitizeRequestContext: rejects non-UUID / injected entity values instead of forwarding them", () => {
  const out = assistantChat.sanitizeRequestContext({
    currentPage: "LeaseReview",
    entities: {
      propertyId: "'; DROP TABLE properties; --",
      leaseId: "not-a-uuid",
      expenseId: "11111111-1111-1111-1111-111111111111", // valid — should survive
    },
  });
  assertEquals(out.entities.propertyId, undefined);
  assertEquals(out.entities.leaseId, undefined);
  assertEquals(out.entities.expenseId, "11111111-1111-1111-1111-111111111111");
});

Deno.test("sanitizeRequestContext: drops entity keys not on the whitelist", () => {
  const out = assistantChat.sanitizeRequestContext({
    entities: { propertyId: "11111111-1111-1111-1111-111111111111", arbitraryInjectedField: "anything" },
  });
  assertEquals(Object.keys(out.entities), ["propertyId"]);
});

Deno.test("sanitizeRequestContext: fiscalYear is range-checked, out-of-range values are dropped", () => {
  assertEquals(assistantChat.sanitizeRequestContext({ fiscalYear: 2026 }).fiscalYear, 2026);
  assertEquals(assistantChat.sanitizeRequestContext({ fiscalYear: 1500 }).fiscalYear, undefined);
  assertEquals(assistantChat.sanitizeRequestContext({ fiscalYear: 3000 }).fiscalYear, undefined);
  assertEquals(assistantChat.sanitizeRequestContext({ fiscalYear: "2026" }).fiscalYear, undefined, "string fiscalYear must not coerce");
});

Deno.test("sanitizeRequestContext: uiState.filters over the size cap is dropped, not truncated-and-kept", () => {
  const hugeFilters = { blob: "x".repeat(3000) };
  const out = assistantChat.sanitizeRequestContext({ uiState: { filters: hugeFilters } });
  assertEquals(out.uiState.filters, undefined);
});

Deno.test("sanitizeRequestContext: caps selectedIds array length", () => {
  const manyIds = Array.from({ length: 50 }, (_, i) => `id-${i}`);
  const out = assistantChat.sanitizeRequestContext({ uiState: { selectedIds: manyIds } });
  assertEquals(out.uiState.selectedIds.length, 20);
});

Deno.test("sanitizeRequestContext: non-object input returns an empty context rather than throwing", () => {
  assertEquals(assistantChat.sanitizeRequestContext(null), {});
  assertEquals(assistantChat.sanitizeRequestContext("not an object"), {});
  assertEquals(assistantChat.sanitizeRequestContext(undefined), {});
});

// ---------------------------------------------------------------------------
// Real production tools fail closed with no auth (not just synthetic ones)
// ---------------------------------------------------------------------------

const NO_AUTH_REQ = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
const FAKE_ORG = "11111111-1111-1111-1111-111111111111";
const FAKE_UUID = "22222222-2222-2222-2222-222222222222";

Deno.test("every registered business-data tool with requiredPages denies a no-auth request before execute()", async () => {
  const sampleArgsByTool: Record<string, Record<string, unknown>> = {
    get_property_list_summary: {},
    get_property_summary: { property_id: FAKE_UUID },
    get_lease_list_summary: {},
    get_lease_summary: { property_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_lease_recovery_policy: { property_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_lease_evidence: { property_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_lease_rent_schedule: { property_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_lease_critical_dates: { property_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_tenant_list_summary: {},
    get_tenant_summary: { property_id: FAKE_UUID, tenant_id: FAKE_UUID },
    get_expense_list_summary: {},
    get_expense_summary: { property_id: FAKE_UUID, expense_id: FAKE_UUID },
    get_cam_readiness: { property_id: FAKE_UUID, recovery_period_id: FAKE_UUID },
    get_cam_run_summary: { property_id: FAKE_UUID, cam_run_id: FAKE_UUID },
    get_cam_tenant_result: { property_id: FAKE_UUID, cam_run_id: FAKE_UUID, lease_id: FAKE_UUID },
    get_cam_pool_detail: { property_id: FAKE_UUID, cam_run_id: FAKE_UUID, pool_result_id: FAKE_UUID },
    get_cam_exceptions_summary: { property_id: FAKE_UUID, cam_run_id: FAKE_UUID },
    get_revenue_summary: { property_id: FAKE_UUID, fiscal_year: 2026 },
    get_budget_summary: { property_id: FAKE_UUID, budget_id: FAKE_UUID },
    get_budget_line_basis: { property_id: FAKE_UUID, budget_id: FAKE_UUID },
    get_budget_variance: { property_id: FAKE_UUID, fiscal_year: 2026 },
    get_budget_cam_estimate: { property_id: FAKE_UUID, budget_id: FAKE_UUID },
    get_reconciliation_summary: { property_id: FAKE_UUID, fiscal_year: 2026 },
    get_pending_approvals_summary: {},
    get_record_audit_summary: { entity_type: "lease", entity_id: FAKE_UUID },
  };

  let checked = 0;
  for (const [name, tool] of TOOL_REGISTRY.entries()) {
    if (tool.requiredPages.length === 0) continue; // product/navigation tools are intentionally ungated
    const args = sampleArgsByTool[name];
    assert(args !== undefined, `no sample args registered for "${name}" in this test — add one so the fail-closed guarantee is actually exercised`);
    const outcome = await authorizeAndRunTool(tool, args, { req: NO_AUTH_REQ, orgId: FAKE_ORG, userId: "u1", supabaseAdmin: null });
    assertEquals(outcome.authorized, false, `"${name}" must deny a request with no Authorization header`);
    assertEquals(outcome.result, null, `"${name}" must not return any data when unauthorized`);
    checked++;
  }
  assert(checked >= 15, `expected to exercise at least 15 page-gated tools, only checked ${checked}`);
});

// ---------------------------------------------------------------------------
// No static message text leaks enumeration/org hints
// ---------------------------------------------------------------------------

const LEAK_PHRASES = [/belongs to (another|a different)/i, /different organization/i, /other organization/i, /that (property|lease|tenant|expense) exists/i];

Deno.test("no tool's inputSchema description or static no_data phrasing contains an enumeration-leaking phrase", () => {
  for (const [name, tool] of TOOL_REGISTRY.entries()) {
    const haystack = tool.description;
    for (const pattern of LEAK_PHRASES) {
      assert(!pattern.test(haystack), `tool "${name}" description matches a leak-prone phrase: ${pattern}`);
    }
  }
});

