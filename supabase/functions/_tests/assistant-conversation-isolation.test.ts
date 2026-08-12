// @ts-nocheck
// Conversation-history isolation tests for assistant-chat-v1.
// These are deliberately pure/in-memory: they verify the edge function's
// conversation scoping helpers without opening a Supabase connection.
//
// Run: deno test --allow-env --allow-read --no-check --no-lock supabase/functions/_tests/assistant-conversation-isolation.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shapeFinalResponse } from "../_shared/assistant/grounding/response-shaper.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: assistantChat } = await import("../assistant-chat-v1/index.ts");
(Deno as any).serve = realServe;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ACTING_A = "33333333-3333-3333-3333-333333333333";
const ACTING_B = "44444444-4444-4444-4444-444444444444";
const USER_A = "55555555-5555-5555-5555-555555555555";
const USER_B = "66666666-6666-6666-6666-666666666666";
const CONV_A = "77777777-7777-7777-7777-777777777777";
const CONV_B = "88888888-8888-8888-8888-888888888888";

class QueryDouble {
  rows: any[];
  filters: Array<(row: any) => boolean> = [];
  orderSpec: { column: string; ascending: boolean } | null = null;
  limitCount: number | null = null;

  constructor(rows: any[]) {
    this.rows = rows;
  }

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row?.[column] === value);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push((row) => (value === null ? row?.[column] == null : row?.[column] === value));
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderSpec = { column, ascending: options.ascending !== false };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  async maybeSingle() {
    return { data: this.filtered()[0] ?? null, error: null };
  }

  then(resolve: any, reject: any) {
    return Promise.resolve({ data: this.filtered(), error: null }).then(resolve, reject);
  }

  filtered() {
    let out = this.rows.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.orderSpec) {
      const { column, ascending } = this.orderSpec;
      out = [...out].sort((a, b) => {
        const av = String(a?.[column] ?? "");
        const bv = String(b?.[column] ?? "");
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitCount != null) out = out.slice(0, this.limitCount);
    return out;
  }
}

function fakeSupabase(tables: Record<string, any[]>) {
  return {
    from(name: string) {
      return new QueryDouble(tables[name] ?? []);
    },
  };
}

Deno.test("assistant history isolation: User A cannot load User B conversation", async () => {
  const supabase = fakeSupabase({
    assistant_conversations: [{ id: CONV_A, org_id: ORG_A, acting_org_id: null, user_id: USER_B }],
  });

  const found = await assistantChat.findExistingAssistantConversationId(supabase, CONV_A, {
    orgId: ORG_A,
    userId: USER_A,
    actingOrgId: null,
  });

  assertEquals(found, null);
});

Deno.test("assistant history isolation: Org A cannot load an Org B conversation", async () => {
  const supabase = fakeSupabase({
    assistant_conversations: [{ id: CONV_A, org_id: ORG_B, acting_org_id: null, user_id: USER_A }],
  });

  const found = await assistantChat.findExistingAssistantConversationId(supabase, CONV_A, {
    orgId: ORG_A,
    userId: USER_A,
    actingOrgId: null,
  });

  assertEquals(found, null);
});

Deno.test("assistant history isolation: changing acting org prevents previous-org messages entering prompt", async () => {
  const supabase = fakeSupabase({
    assistant_conversations: [{ id: CONV_A, org_id: ORG_A, acting_org_id: ACTING_B, user_id: USER_A }],
    assistant_messages: [
      { conversation_id: CONV_A, org_id: ORG_A, acting_org_id: ACTING_B, user_id: USER_A, role: "assistant", content: "Protected Org B NOI is $123,456.", created_at: "2026-01-01T00:00:00Z" },
    ],
  });

  const identity = { orgId: ORG_A, userId: USER_A, actingOrgId: ACTING_A };
  const found = await assistantChat.findExistingAssistantConversationId(supabase, CONV_A, identity);
  const priorTurns = await assistantChat.loadAssistantPriorTurns(supabase, CONV_A, identity);

  assertEquals(found, null);
  assertEquals(priorTurns, []);
});

Deno.test("assistant history isolation: manually supplying another conversation UUID fails closed", async () => {
  const supabase = fakeSupabase({
    assistant_conversations: [{ id: CONV_B, org_id: ORG_A, acting_org_id: null, user_id: USER_A }],
  });

  const found = await assistantChat.findExistingAssistantConversationId(supabase, CONV_A, {
    orgId: ORG_A,
    userId: USER_A,
    actingOrgId: null,
  });

  assertEquals(found, null);
});

Deno.test("assistant history isolation: no acting-org request only loads null acting-org history", async () => {
  const supabase = fakeSupabase({
    assistant_messages: [
      { conversation_id: CONV_A, org_id: ORG_A, acting_org_id: ACTING_A, user_id: USER_A, role: "assistant", content: "Wrong acting org", created_at: "2026-01-02T00:00:00Z" },
      { conversation_id: CONV_A, org_id: ORG_A, acting_org_id: null, user_id: USER_A, role: "user", content: "Correct null acting org", created_at: "2026-01-01T00:00:00Z" },
    ],
  });

  const priorTurns = await assistantChat.loadAssistantPriorTurns(supabase, CONV_A, {
    orgId: ORG_A,
    userId: USER_A,
    actingOrgId: null,
  });

  assertEquals(priorTurns, [{ role: "user", content: "Correct null acting org" }]);
});

Deno.test("assistant history isolation: previous authorized data cannot substitute for a fresh tool lookup", () => {
  const shaped = shapeFinalResponse(
    {
      status: "answered",
      answer: "Based on the earlier message, this property's NOI is $123,456.",
      citations: [],
      navigation: [],
      limitations: [],
    },
    [],
  );

  assertEquals(shaped.status, "insufficient_evidence");
  assertEquals(shaped.answer.includes("$123,456"), false);
});

Deno.test("assistant history isolation: denied current resource lookup does not let history ground the answer", () => {
  const shaped = shapeFinalResponse(
    {
      status: "answered",
      answer: "The previous CAM answer still says Tenant A owes $23,000.",
      citations: [],
      navigation: [],
      limitations: [],
    },
    [{ authorized: false, denialKind: "property", result: null, runRecord: {} as any }],
  );

  assertEquals(shaped.status, "insufficient_evidence");
});

Deno.test("assistant history isolation: acting-org header is accepted only when it is a UUID", () => {
  const valid = new Request("https://example.com", { headers: { "x-acting-org-id": ACTING_A } });
  const invalid = new Request("https://example.com", { headers: { "x-acting-org-id": "not-a-uuid" } });

  assertEquals(assistantChat.getAssistantActingOrgId(valid), ACTING_A);
  assertEquals(assistantChat.getAssistantActingOrgId(invalid), null);
});