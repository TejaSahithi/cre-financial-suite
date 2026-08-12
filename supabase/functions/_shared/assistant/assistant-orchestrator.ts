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
import { PLATFORM_CAPABILITIES, PLATFORM_WORKFLOWS } from "./capabilities/platform-capability-registry.ts";

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

const MODULE_HIGHLIGHT_IDS: Record<string, string[]> = {
  leases: ["leases", "lease_upload", "lease_review", "lease_detail", "lease_expense_rules", "rent_projection", "critical_dates"],
  expenses: ["expenses", "add_expense", "bulk_import", "lease_expense_classification", "lease_expense_rules"],
  cam: ["cam_dashboard", "cam_setup", "cam_run", "cam_lease_detail", "cam_pool_detail", "cam_approval", "cam_posting"],
  budgets: ["budget_dashboard", "create_budget", "budget_review", "variance", "reconciliation"],
  properties: ["properties", "property_detail", "buildings", "units"],
  tenants: ["tenants", "tenant_detail", "billing"],
  revenue: ["revenue", "rent_projection"],
  admin: ["organization_settings", "user_management", "audit_log", "chart_of_accounts"],
};

const MODULE_ALIASES: Array<{ module: string; terms: string[] }> = [
  { module: "leases", terms: ["lease module", "leases module", "leasing module", "lease feature", "leases feature"] },
  { module: "expenses", terms: ["expense module", "expenses module", "expense feature", "expenses feature"] },
  { module: "cam", terms: ["cam module", "cam feature", "cam workflow", "common area maintenance module"] },
  { module: "budgets", terms: ["budget module", "budgets module", "budgeting module", "budget feature"] },
  { module: "properties", terms: ["property module", "properties module", "property feature"] },
  { module: "tenants", terms: ["tenant module", "tenants module", "tenant feature"] },
  { module: "revenue", terms: ["revenue module", "revenue feature"] },
  { module: "admin", terms: ["admin module", "administration module", "settings module"] },
];

function normalizeQuestion(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isGenericProductKnowledgeQuestion(normalized: string): boolean {
  const asksForExplanation = /\b(what|explain|describe|tell|how|why|purpose|used)\b/.test(normalized);
  const asksAboutProductSurface = /\b(module|page|feature|workflow|flow|platform|system|app|application|doing|does|do|used for|purpose)\b/.test(normalized);
  return asksForExplanation && asksAboutProductSurface;
}

function findRequestedModule(normalized: string): string | null {
  for (const entry of MODULE_ALIASES) {
    if (entry.terms.some((term) => normalized.includes(term))) return entry.module;
  }
  return null;
}

function findRequestedCapability(normalized: string, requestContext?: AssistantRequestContext): any | null {
  const asksAboutCurrentPage = /\b(this page|current page|here)\b/.test(normalized);
  if (asksAboutCurrentPage && requestContext?.currentPage) {
    const current = PLATFORM_CAPABILITIES.find((capability: any) => capability.page === requestContext.currentPage);
    if (current?.sensitivity === "product") return current;
  }

  const candidates = [...PLATFORM_CAPABILITIES]
    .filter((capability: any) => capability.sensitivity === "product")
    .sort((a: any, b: any) => Math.max(b.page.length, b.label.length) - Math.max(a.page.length, a.label.length));

  for (const capability of candidates) {
    const terms = [
      capability.page,
      capability.label,
      `${capability.label} page`,
      `${capability.label} feature`,
    ].map(normalizeQuestion);
    if (terms.some((term) => term.length >= 4 && normalized.includes(term))) return capability;
  }
  return null;
}

function getModuleCapabilities(moduleName: string): any[] {
  const ids = MODULE_HIGHLIGHT_IDS[moduleName] ?? [];
  const byId = new Map(PLATFORM_CAPABILITIES.map((capability: any) => [capability.id, capability]));
  const highlighted = ids.map((id) => byId.get(id)).filter(Boolean);
  if (highlighted.length > 0) return highlighted;
  return PLATFORM_CAPABILITIES.filter((capability: any) => capability.module === moduleName && capability.sensitivity === "product");
}

function isPlatformFlowQuestion(normalized: string): boolean {
  return /\b(business flow|end to end|entire platform|whole platform|platform flow|how the platform works|what can you do|what does the platform do|platform doing)\b/.test(normalized);
}

function maybeAnswerPlatformFlowQuestion(normalized: string): OrchestratorResult | null {
  if (!isPlatformFlowQuestion(normalized)) return null;

  const capabilityIds = ["properties", "leases", "lease_review", "lease_expense_rules", "expenses", "lease_expense_classification", "cam_setup", "cam_run", "revenue", "budget_dashboard", "variance", "reconciliation", "approvals"];
  const byId = new Map(PLATFORM_CAPABILITIES.map((capability: any) => [capability.id, capability]));
  const capabilities = capabilityIds.map((id) => byId.get(id)).filter((capability: any) => capability?.sensitivity === "product");
  const workflowSummary = PLATFORM_WORKFLOWS.map((workflow: any) => `${workflow.label}: ${workflow.description}`).join(" ");

  return buildProductKnowledgeResult(
    capabilities,
    [
      "End to end, the platform turns property, lease, expense, CAM, revenue, and budget data into an auditable CRE financial workflow.",
      "Typical flow: set up properties, buildings, units, and tenants; upload and review leases; approve canonical lease terms and recovery rules; record or import expenses; classify expenses against lease rules; send approved recoverable expenses into CAM; run, review, approve, and post CAM; then use approved lease, CAM, revenue, actuals, and budget data for reporting, variance, reconciliation, and approvals.",
      `Important workflows: ${workflowSummary}`,
      "The assistant can explain these modules generically from product knowledge. For record-specific answers, it must use authorized tools so it only reads data the signed-in user can access.",
    ].join("\n\n"),
  );
}
function buildProductKnowledgeResult(capabilities: any[], answer: string): OrchestratorResult {
  return {
    status: "answered",
    answer,
    citations: capabilities.slice(0, 6).map((capability: any) => ({ type: "capability", label: `Platform capability: ${capability.label}` })),
    navigation: capabilities.slice(0, 4).map((capability: any) => ({ label: `Open ${capability.label}`, page: capability.page })),
    limitations: ["Generic product explanation only; no customer lease, property, expense, CAM, revenue, or budget records were read."],
    toolRuns: [],
    promptTokens: 0,
    completionTokens: 0,
  };
}

function maybeAnswerProductKnowledgeQuestion(userMessage: string, requestContext?: AssistantRequestContext): OrchestratorResult | null {
  const normalized = normalizeQuestion(userMessage);
  if (!isGenericProductKnowledgeQuestion(normalized)) return null;

  const platformFlowAnswer = maybeAnswerPlatformFlowQuestion(normalized);
  if (platformFlowAnswer) return platformFlowAnswer;

  const capability = findRequestedCapability(normalized, requestContext);
  if (capability) {
    const details = [
      capability.prerequisites?.length ? `Prerequisites: ${capability.prerequisites.join(" ")}` : "",
      capability.downstreamEffects?.length ? `Downstream effects: ${capability.downstreamEffects.join(" ")}` : "",
      capability.relatedPages?.length ? `Related pages: ${capability.relatedPages.join(", ")}.` : "",
    ].filter(Boolean).join("\n\n");
    return buildProductKnowledgeResult(
      [capability],
      [`${capability.label} is used for ${capability.purpose.replace(/\.$/, "").toLowerCase()}. ${capability.description}`, details].filter(Boolean).join("\n\n"),
    );
  }

  const moduleName = findRequestedModule(normalized);
  if (!moduleName) return null;

  const capabilities = getModuleCapabilities(moduleName).filter((item: any) => item?.sensitivity === "product");
  if (capabilities.length === 0) return null;

  const primary = capabilities[0];
  const highlights = capabilities.slice(1, 6).map((item: any) => `${item.label}: ${item.purpose.replace(/\.$/, "")}.`);
  const workflows = PLATFORM_WORKFLOWS.filter((workflow: any) => workflow.relatedPages?.some((page: string) => capabilities.some((item: any) => item.page === page))).slice(0, 2);
  const workflowText = workflows.length > 0 ? ` It also connects into workflows like ${workflows.map((workflow: any) => workflow.label).join(" and ")}.` : "";

  return buildProductKnowledgeResult(
    capabilities,
    [
      `The ${primary.label} module centers on ${primary.purpose.replace(/\.$/, "").toLowerCase()}. ${primary.description}`,
      highlights.length > 0 ? `Key parts: ${highlights.join(" ")}` : "",
      `Approved or finalized outputs from this area can feed downstream modules such as expense classification, CAM, revenue, budgets, and reporting when those workflows depend on them.${workflowText}`,
    ].filter(Boolean).join("\n\n"),
  );
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
  const productKnowledgeAnswer = maybeAnswerProductKnowledgeQuestion(userMessage, requestContext);
  if (productKnowledgeAnswer) return productKnowledgeAnswer;

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
