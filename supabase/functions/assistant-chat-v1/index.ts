// @ts-nocheck
// Assistant V1 — global, read-only, role-aware AI Assistant chat endpoint.
//
// Request/response shapes: see _shared/assistant/assistant-contracts.ts.
// Security sequence (never reordered): verifyUser -> resolve org server-side
// -> (per tool call, inside the orchestrator) assert page/property/portfolio
// access -> retrieve -> sanitize -> return. No business data reaches the
// Assistant LLM before its authorization check passes — see
// _shared/assistant/tools/tool-broker.ts.
import { corsHeaders } from "../_shared/cors.ts";
import { resolveAssistantContext } from "../_shared/assistant/context/resolve-assistant-context.ts";
import { runAssistantOrchestrator } from "../_shared/assistant/assistant-orchestrator.ts";
import type { AssistantChatResponse, AssistantRequestContext } from "../_shared/assistant/assistant-contracts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;
const ENTITY_KEYS = ["portfolioId", "propertyId", "buildingId", "unitId", "tenantId", "leaseId", "expenseId", "camRunId", "camPoolResultId", "budgetId", "recoveryPeriodId"];
const MIN_FISCAL_YEAR = 2000;
const MAX_FISCAL_YEAR = 2100;

function errorStatus(message: string): number {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|invalid|too long|not found/i.test(message)) return 400;
  return 500;
}

/** Whitelists and size-limits the client-supplied context (section 13) — the
 * browser can reference entity ids but can never smuggle arbitrary payload
 * data into the LLM's context through this object. */
function sanitizeRequestContext(raw: unknown): AssistantRequestContext {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const out: AssistantRequestContext = {};

  if (typeof input.currentPage === "string") out.currentPage = input.currentPage.slice(0, 100);
  if (typeof input.route === "string") out.route = input.route.slice(0, 200);
  if (typeof input.fiscalYear === "number" && Number.isInteger(input.fiscalYear) && input.fiscalYear >= MIN_FISCAL_YEAR && input.fiscalYear <= MAX_FISCAL_YEAR) {
    out.fiscalYear = input.fiscalYear;
  }

  const entitiesInput = input.entities;
  if (entitiesInput && typeof entitiesInput === "object") {
    const entities: Record<string, string> = {};
    for (const key of ENTITY_KEYS) {
      const value = (entitiesInput as Record<string, unknown>)[key];
      if (typeof value === "string" && UUID_RE.test(value)) entities[key] = value;
    }
    out.entities = entities;
  }

  const uiStateInput = input.uiState;
  if (uiStateInput && typeof uiStateInput === "object") {
    const ui = uiStateInput as Record<string, unknown>;
    out.uiState = {
      selectedTab: typeof ui.selectedTab === "string" ? ui.selectedTab.slice(0, 100) : undefined,
      selectedIds: Array.isArray(ui.selectedIds) ? ui.selectedIds.filter((v) => typeof v === "string").slice(0, 20) : undefined,
      filters: ui.filters && typeof ui.filters === "object" && JSON.stringify(ui.filters).length <= 2000 ? (ui.filters as Record<string, unknown>) : undefined,
    };
  }

  return out;
}

type AssistantConversationIdentity = {
  orgId: string;
  userId: string;
  actingOrgId: string | null;
};

function getAssistantActingOrgId(req: Request): string | null {
  const raw = req.headers.get("x-acting-org-id");
  if (!raw) return null;
  const trimmed = raw.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function applyAssistantConversationScope<T extends { eq: (...args: unknown[]) => T; is: (...args: unknown[]) => T }>(
  query: T,
  identity: AssistantConversationIdentity,
): T {
  const scoped = query
    .eq("org_id", identity.orgId)
    .eq("user_id", identity.userId);

  return identity.actingOrgId
    ? scoped.eq("acting_org_id", identity.actingOrgId)
    : scoped.is("acting_org_id", null);
}

async function findExistingAssistantConversationId(
  supabaseAdmin: any,
  requestedConversationId: string | null,
  identity: AssistantConversationIdentity,
): Promise<string | null> {
  if (!requestedConversationId) return null;

  const { data: existing } = await applyAssistantConversationScope(
    supabaseAdmin
      .from("assistant_conversations")
      .select("id")
      .eq("id", requestedConversationId),
    identity,
  ).maybeSingle();

  return existing?.id ?? null;
}

async function loadAssistantPriorTurns(
  supabaseAdmin: any,
  conversationId: string,
  identity: AssistantConversationIdentity,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data: history, error: historyError } = await applyAssistantConversationScope(
    supabaseAdmin
      .from("assistant_messages")
      .select("role, content")
      .eq("conversation_id", conversationId),
    identity,
  )
    .order("created_at", { ascending: false })
    .limit(16);

  if (historyError) {
    console.error("[assistant-chat-v1] failed to load conversation history:", historyError.message);
    return [];
  }

  return (history ?? []).reverse();
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (req.method !== "POST") {
    return jsonResponse({ error: true, message: "Method not allowed" }, 405);
  }

  try {
    const { userId, orgId, supabaseAdmin } = await resolveAssistantContext(req);
    const actingOrgId = getAssistantActingOrgId(req);
    const conversationIdentity = { orgId, userId, actingOrgId };

    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) throw new Error("message is required");
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);

    const requestedConversationId = typeof body?.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null;
    const requestContext = sanitizeRequestContext(body?.context);

    // Resolve or create the conversation, strictly scoped to this
    // user+organization+acting-organization identity. A conversationId outside
    // that identity is never reused; we fail closed by creating a fresh
    // conversation, so prior protected messages cannot cross tenant/acting-org
    // boundaries.
    let conversationId = await findExistingAssistantConversationId(supabaseAdmin, requestedConversationId, conversationIdentity);
    let priorTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (!conversationId) {
      const { data: created, error: createError } = await supabaseAdmin
        .from("assistant_conversations")
        .insert({ org_id: orgId, acting_org_id: actingOrgId, user_id: userId, title: message.slice(0, 80) })
        .select("id")
        .single();
      if (createError) throw new Error(`Failed to create conversation: ${createError.message}`);
      conversationId = created.id;
    } else {
      await applyAssistantConversationScope(
        supabaseAdmin
          .from("assistant_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId),
        conversationIdentity,
      );

      // Multi-turn memory (section 14): replay recent prior messages of THIS
      // conversation so follow-ups like "what do I need to fix?" resolve
      // against the same record without the user repeating ids. This is
      // conversational context only — it never substitutes for a fresh
      // authorization check on any figure restated in the new answer (see
      // assistant-orchestrator.ts's formatPriorTurns / response-shaper).
      priorTurns = await loadAssistantPriorTurns(supabaseAdmin, conversationId, conversationIdentity);
    }

    await supabaseAdmin.from("assistant_messages").insert({
      conversation_id: conversationId,
      org_id: orgId,
      acting_org_id: actingOrgId,
      user_id: userId,
      role: "user",
      content: message,
      ui_context: requestContext,
    });

    const startedAt = Date.now();
    const result = await runAssistantOrchestrator(message, requestContext, { req, orgId, userId, supabaseAdmin }, priorTurns);
    const latencyMs = Date.now() - startedAt;

    const { data: assistantMessage, error: assistantInsertError } = await supabaseAdmin
      .from("assistant_messages")
      .insert({
        conversation_id: conversationId,
        org_id: orgId,
        acting_org_id: actingOrgId,
        user_id: userId,
        role: "assistant",
        content: result.answer,
        response_status: result.status,
        citations: result.citations,
        navigation: result.navigation,
        limitations: result.limitations,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        latency_ms: latencyMs,
      })
      .select("id")
      .single();
    if (assistantInsertError) throw new Error(`Failed to save assistant message: ${assistantInsertError.message}`);

    if (result.toolRuns.length > 0) {
      // Best-effort telemetry — never let a logging failure fail the user-facing response.
      const rows = result.toolRuns.map((run) => ({
        message_id: assistantMessage.id,
        org_id: orgId,
        acting_org_id: actingOrgId,
        user_id: userId,
        tool_name: run.tool_name,
        arguments: run.arguments,
        authorized: run.authorized,
        denial_reason: run.denial_reason,
        result_summary: run.result_summary,
        latency_ms: run.latency_ms,
      }));
      const { error: toolRunError } = await supabaseAdmin.from("assistant_tool_runs").insert(rows);
      if (toolRunError) console.error("[assistant-chat-v1] failed to persist tool run telemetry:", toolRunError.message);
    }

    const response: AssistantChatResponse = {
      conversationId,
      messageId: assistantMessage.id,
      status: result.status,
      answer: result.answer,
      citations: result.citations,
      navigation: result.navigation,
      limitations: result.limitations,
    };
    return jsonResponse(response);
  } catch (err) {
    const message = err?.message || "Assistant request failed";
    console.error("[assistant-chat-v1] error:", message);
    return jsonResponse({ error: true, message, error_code: "ASSISTANT_CHAT_FAILED" }, errorStatus(message));
  }
});

// Exposed for tests only (see supabase/functions/_tests/assistant-request-sanitization.test.ts),
// matching this repo's existing __test__ export convention (normalize-pdf-output/index.ts).
export const __test__ = {
  sanitizeRequestContext,
  getAssistantActingOrgId,
  applyAssistantConversationScope,
  findExistingAssistantConversationId,
  loadAssistantPriorTurns,
};

