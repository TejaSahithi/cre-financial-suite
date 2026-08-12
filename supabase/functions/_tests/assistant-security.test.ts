// @ts-nocheck
// Section 29 (Assistant security tests). Pure-logic / no-live-Supabase
// tests, matching this repo's existing Deno test convention (see
// release11-copilot-orchestrator.test.ts, business-extraction-provider-
// default-failsafe.test.ts) — no network calls except the intentionally
// mocked fetch in the tool-loop-cap test below.
//
// Run: deno test --allow-env --allow-read --no-check --no-lock supabase/functions/_tests/assistant-security.test.ts

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeAndRunTool } from "../_shared/assistant/tools/tool-broker.ts";
import { TOOL_REGISTRY, getTool, getToolNames } from "../_shared/assistant/tools/tool-registry.ts";
import { runAssistantOrchestrator } from "../_shared/assistant/assistant-orchestrator.ts";
import { shapeFinalResponse } from "../_shared/assistant/grounding/response-shaper.ts";
import type { AssistantTool } from "../_shared/assistant/assistant-contracts.ts";

function withEnv(overrides: Record<string, string | undefined>, fn: () => any) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = Deno.env.get(key);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

// ---------------------------------------------------------------------------
// Tool broker — fails closed by default
// ---------------------------------------------------------------------------

const pageGatedTool: AssistantTool = {
  name: "__test_page_gated_tool",
  description: "test",
  inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  requiredPages: ["CAMDashboard"],
  scopeType: "none",
  accessType: "business_data",
  async execute() {
    return { status: "answered", data: { leaked: true } };
  },
};

Deno.test("tool broker: a request with no Authorization header is denied (page access), never reaches execute()", async () => {
  const req = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
  const outcome = await authorizeAndRunTool(pageGatedTool, {}, { req, orgId: "11111111-1111-1111-1111-111111111111", userId: "u1", supabaseAdmin: null });
  assertEquals(outcome.authorized, false);
  assertEquals(outcome.denialKind, "page");
  assertEquals(outcome.result, null);
});

const scopedTool: AssistantTool = {
  name: "__test_scoped_tool",
  description: "test",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id"],
    properties: { property_id: { type: "string" } },
  },
  requiredPages: [],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute() {
    return { status: "answered", data: { leaked: true } };
  },
};

Deno.test("tool broker: missing required argument is rejected before any authorization check runs", async () => {
  const req = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
  const outcome = await authorizeAndRunTool(scopedTool, {}, { req, orgId: "org-1", userId: "u1", supabaseAdmin: null });
  assertEquals(outcome.authorized, false);
  assertEquals(outcome.denialKind, "validation");
});

Deno.test("tool broker: an unexpected extra argument is rejected (schema is closed, additionalProperties:false semantics enforced)", async () => {
  const req = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
  const outcome = await authorizeAndRunTool(scopedTool, { property_id: "11111111-1111-1111-1111-111111111111", injected: "DROP TABLE" }, { req, orgId: "org-1", userId: "u1", supabaseAdmin: null });
  assertEquals(outcome.authorized, false);
  assertEquals(outcome.denialKind, "validation");
});

Deno.test("tool broker: a non-UUID scope id is rejected as invalid, never passed through to a property-access check", async () => {
  const req = new Request("https://example.com/assistant-chat-v1", { headers: { Authorization: "Bearer faketoken" }, method: "POST" });
  const outcome = await authorizeAndRunTool(scopedTool, { property_id: "not-a-uuid; DROP TABLE properties;" }, { req, orgId: "org-1", userId: "u1", supabaseAdmin: null });
  assertEquals(outcome.authorized, false);
  assertEquals(outcome.denialKind, "validation");
});

// ---------------------------------------------------------------------------
// Tool registry — closed set, no generic SQL/RPC tools ever registered
// ---------------------------------------------------------------------------

Deno.test("tool registry: forbidden generic tool names are never registered", () => {
  for (const forbidden of ["execute_sql", "run_sql", "query_database", "query_table", "generic_rpc"]) {
    assertEquals(getTool(forbidden), undefined);
  }
});

Deno.test("tool registry: getTool only ever returns tools present in TOOL_REGISTRY (no dynamic/invented tools)", () => {
  const names = getToolNames();
  assertEquals(names.length > 0, true);
  for (const name of names) {
    assertNotEquals(TOOL_REGISTRY.get(name), undefined);
  }
  assertEquals(getTool("something_the_model_made_up"), undefined);
});

// ---------------------------------------------------------------------------
// Response shaper — leakage guard: no unverified financial figures
// ---------------------------------------------------------------------------

Deno.test("response shaper: suppresses a dollar figure in the final answer when no tool call actually retrieved data this turn", () => {
  const shaped = shapeFinalResponse(
    { status: "answered", answer: "Tenant A's CAM recovery is $183,440.", citations: [], navigation: [], limitations: [] },
    [],
  );
  assertEquals(shaped.status, "insufficient_evidence");
  assertEquals(/\$/.test(shaped.answer), false);
});

Deno.test("response shaper: allows a dollar figure through when a real, authorized tool call backs it", () => {
  const shaped = shapeFinalResponse(
    { status: "answered", answer: "Tenant A's CAM recovery is $183,440.", citations: [], navigation: [], limitations: [] },
    [{ authorized: true, result: { status: "answered", data: { final_recovery: 183440 } }, runRecord: {} as any }],
  );
  assertEquals(shaped.status, "answered");
  assertEquals(shaped.answer.includes("$183,440"), true);
});

Deno.test("response shaper: a denied tool call does NOT count as grounding, dollar figures still suppressed", () => {
  const shaped = shapeFinalResponse(
    { status: "answered", answer: "That property spent $50,000 last year.", citations: [], navigation: [], limitations: [] },
    [{ authorized: false, denialKind: "property", result: null, runRecord: {} as any }],
  );
  assertEquals(shaped.status, "insufficient_evidence");
});

// ---------------------------------------------------------------------------
// Orchestrator — hard iteration cap (never an infinite tool loop)
// ---------------------------------------------------------------------------

Deno.test("orchestrator: stops after the fixed maximum number of tool-call turns, even if the model never emits final", async () => {
  const realFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    const decision = { type: "tool_call", tool_call: { tool: "get_page_definition", arguments: JSON.stringify({ page: "Dashboard" }) }, final: null };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
        model: "gpt-5.4-mini-3",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        ASSISTANT_AZURE_OPENAI_ENDPOINT: "https://assistant-resource.openai.azure.com",
        ASSISTANT_AZURE_OPENAI_API_KEY: "assistant-key",
        ASSISTANT_AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-3",
      },
      async () => {
        const req = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
        const result = await runAssistantOrchestrator("What does the dashboard do?", {}, { req, orgId: "org-1", userId: "u1", supabaseAdmin: null });
        assertEquals(result.status, "insufficient_evidence");
        assertEquals(result.limitations.includes("Reached the maximum tool-call iteration limit."), true);
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assertEquals(callCount, 6);
});

Deno.test("orchestrator: fails safely (status error) when the Assistant LLM is not configured, never falls back silently", async () => {
  await withEnv(
    {
      ASSISTANT_AZURE_OPENAI_ENDPOINT: undefined,
      ASSISTANT_AZURE_OPENAI_API_KEY: undefined,
      ASSISTANT_AZURE_OPENAI_DEPLOYMENT: undefined,
    },
    async () => {
      const req = new Request("https://example.com/assistant-chat-v1", { method: "POST" });
      const result = await runAssistantOrchestrator("What does the dashboard do?", {}, { req, orgId: "org-1", userId: "u1", supabaseAdmin: null });
      assertEquals(result.status, "error");
    },
  );
});
