// @ts-nocheck
/**
 * assistant-orchestrator.ts — the ONE bounded tool loop (section 11, 19).
 * Deliberately a single orchestrator over a flat tool registry, not one
 * agent per domain (section 11 explicitly rules that out).
 *
 * The Assistant's own Azure OpenAI deployment has no native function-calling
 * support in this codebase's LLM layer (confirmed: neither _shared/llm.ts
 * nor anything else here sends `tools`/`tool_choice`) — so each turn is a
 * single strict json_schema call that returns either a tool_call or a final
 * answer (section 19's documented fallback path), and prior turns are
 * replayed as a compact text transcript in the user prompt rather than a
 * native multi-turn messages array.
 */
import { callAssistantLLMStructured, isAssistantLLMConfigured } from "./assistant-llm.ts";
import { buildAssistantSystemPrompt } from "./assistant-system-prompt.ts";
import {
  ASSISTANT_TURN_SCHEMA_NAME,
  buildAssistantTurnJsonSchema,
  type AssistantCitation,
  type AssistantNavigationAction,
  type AssistantRequestContext,
  type AssistantResponseStatus,
} from "./assistant-contracts.ts";
import { getToolNames, getTool } from "./tools/tool-registry.ts";
import { authorizeAndRunTool, type ToolBrokerOutcome, type ToolRunRecord } from "./tools/tool-broker.ts";
import { shapeFinalResponse } from "./grounding/response-shaper.ts";

const MAX_TOOL_ITERATIONS = 6;

export interface OrchestratorResult {
  status: AssistantResponseStatus;
  answer: string;
  citations: AssistantCitation[];
  navigation: AssistantNavigationAction[];
  limitations: string[];
  toolRuns: ToolRunRecord[];
  promptTokens: number;
  completionTokens: number;
}

function truncate(value: unknown, maxLen = 1800): string {
  const s = JSON.stringify(value);
  if (!s) return "null";
  return s.length > maxLen ? `${s.slice(0, maxLen)}...(truncated)` : s;
}

export interface PriorTurn {
  role: "user" | "assistant";
  content: string;
}

/** Prior turns are replayed as compact text, not re-authorized or re-run —
 * they are conversational memory only. Every fact the model states in THIS
 * turn's final answer still has to come from a tool call made in THIS
 * turn's own transcript (see response-shaper's grounding check), so stale
 * history can inform follow-up questions ("what do I need to fix?") without
 * ever becoming a substitute for a fresh authorization check. Capped to the
 * last few turns and truncated per-message for cost control (section 26).
 */
const MAX_PRIOR_TURNS = 8;
const MAX_PRIOR_MESSAGE_LENGTH = 600;

function formatPriorTurns(priorTurns: PriorTurn[] | undefined): string {
  if (!priorTurns || priorTurns.length === 0) return "";
  const recent = priorTurns.slice(-MAX_PRIOR_TURNS);
  const lines = recent.map((turn) => {
    const speaker = turn.role === "user" ? "User" : "Assistant";
    const content = turn.content.length > MAX_PRIOR_MESSAGE_LENGTH ? `${turn.content.slice(0, MAX_PRIOR_MESSAGE_LENGTH)}...` : turn.content;
    return `${speaker}: ${content}`;
  });
  return `Earlier in this conversation (for context only — re-derive any figure via a fresh tool call, do not restate a number from here without one):\n${lines.join("\n")}`;
}

export async function runAssistantOrchestrator(
  userMessage: string,
  requestContext: AssistantRequestContext | undefined,
  toolCtx: { req: Request; orgId: string; userId: string; supabaseAdmin: any },
  priorTurns?: PriorTurn[],
): Promise<OrchestratorResult> {
  if (!isAssistantLLMConfigured()) {
    return {
      status: "error",
      answer: "The Assistant is not configured yet — please contact your administrator.",
      citations: [],
      navigation: [],
      limitations: ["ASSISTANT_AZURE_OPENAI_* configuration is missing."],
      toolRuns: [],
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  const systemPrompt = buildAssistantSystemPrompt(requestContext);
  const toolNames = getToolNames();
  const schema = buildAssistantTurnJsonSchema(toolNames);

  const outcomes: ToolBrokerOutcome[] = [];
  const priorTurnsBlock = formatPriorTurns(priorTurns);
  const transcriptLines: string[] = [
    ...(priorTurnsBlock ? [priorTurnsBlock] : []),
    `User question: ${userMessage}`,
  ];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const userPrompt = transcriptLines.join("\n\n");
    const result = await callAssistantLLMStructured({
      systemPrompt,
      userPrompt,
      schemaName: ASSISTANT_TURN_SCHEMA_NAME,
      schema,
      temperature: 0.1,
    });

    totalPromptTokens += result.promptTokens ?? 0;
    totalCompletionTokens += result.completionTokens ?? 0;

    if (result.status !== "success" || !result.data) {
      return {
        status: "error",
        answer: "I ran into a technical issue answering that. Please try again in a moment.",
        citations: [],
        navigation: [],
        limitations: [`assistant_llm_status:${result.status}`],
        toolRuns: outcomes.map((o) => o.runRecord),
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    const decision = result.data as any;

    if (decision.type === "final" && decision.final) {
      const shaped = shapeFinalResponse(
        {
          status: decision.final.status,
          answer: decision.final.answer,
          citations: (decision.final.citations ?? []).map((c: any) => ({ type: c.type, label: c.label, entityId: c.entityId ?? undefined, page: c.page ?? undefined })),
          navigation: (decision.final.navigation ?? []).map((n: any) => ({ label: n.label, page: n.page })),
          limitations: decision.final.limitations ?? [],
        },
        outcomes,
      );
      return {
        ...shaped,
        toolRuns: outcomes.map((o) => o.runRecord),
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    if (decision.type === "tool_call" && decision.tool_call) {
      const toolName = decision.tool_call.tool;
      const tool = getTool(toolName);
      if (!tool) {
        // Structurally shouldn't happen (enum-constrained), but never trust it blindly.
        transcriptLines.push(`Tool call "${toolName}" rejected: not a registered tool.`);
        continue;
      }

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = decision.tool_call.arguments ? JSON.parse(decision.tool_call.arguments) : {};
      } catch {
        transcriptLines.push(`Tool call "${toolName}" rejected: arguments were not valid JSON.`);
        continue;
      }

      const outcome = await authorizeAndRunTool(tool, parsedArgs, toolCtx);
      outcomes.push(outcome);

      if (!outcome.authorized) {
        transcriptLines.push(
          `Tool call "${toolName}" was NOT authorized (${outcome.denialKind}). Do not claim, guess, or reconstruct this data. ` +
            `If this blocks answering, respond with status "access_denied" using the safe access-denied phrasing — never reveal whether the underlying entity exists.`,
        );
        continue;
      }

      transcriptLines.push(
        `Tool call "${toolName}" result (status=${outcome.result?.status}): ${truncate(outcome.result?.data)}` +
          (outcome.result?.message ? ` note: ${outcome.result.message}` : ""),
      );
      continue;
    }

    // Malformed decision (neither a valid tool_call nor final payload).
    transcriptLines.push("Your previous response did not match the required schema. Respond again with a valid tool_call or final decision.");
  }

  return {
    status: "insufficient_evidence",
    answer: "I wasn't able to gather enough information to answer that confidently within the allowed number of steps. Try asking a more specific question.",
    citations: [],
    navigation: [],
    limitations: ["Reached the maximum tool-call iteration limit."],
    toolRuns: outcomes.map((o) => o.runRecord),
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
  };
}
