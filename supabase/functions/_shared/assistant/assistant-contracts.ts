// @ts-nocheck
/**
 * assistant-contracts.ts — request/response/tool types shared across the
 * Assistant feature. This is the ONLY place these shapes are defined;
 * assistant-chat-v1/index.ts, the orchestrator, and every tool import from
 * here rather than redeclaring inline object shapes.
 */

export const ASSISTANT_SCHEMA_VERSION = "assistant-v1";

// ---------------------------------------------------------------------------
// Inbound request (section 13) — every entity id is an UNTRUSTED reference
// that tools must authorize before use, never a security claim.
// ---------------------------------------------------------------------------

export interface AssistantRequestEntities {
  portfolioId?: string;
  propertyId?: string;
  buildingId?: string;
  unitId?: string;
  tenantId?: string;
  leaseId?: string;
  expenseId?: string;
  camRunId?: string;
  camPoolResultId?: string;
  budgetId?: string;
  recoveryPeriodId?: string;
}

export interface AssistantRequestContext {
  currentPage?: string;
  route?: string;
  /** Scalar, not a UUID entity — e.g. the fiscal year selected on a budget/
   * revenue/variance page. Whitelisted and range-checked separately from
   * `entities` in assistant-chat-v1/index.ts's sanitizeRequestContext. */
  fiscalYear?: number;
  entities?: AssistantRequestEntities;
  uiState?: {
    selectedTab?: string;
    selectedIds?: string[];
    filters?: Record<string, unknown>;
  };
}

export interface AssistantChatRequest {
  conversationId?: string | null;
  message: string;
  context?: AssistantRequestContext;
}

// ---------------------------------------------------------------------------
// Response (section 21-22)
// ---------------------------------------------------------------------------

export type AssistantResponseStatus =
  | "answered"
  | "access_denied"
  | "no_data"
  | "insufficient_evidence"
  | "unsupported"
  | "error";

export interface AssistantCitation {
  type: string; // e.g. "lease_evidence" | "cam_calculation_line" | "budget_basis" | "capability"
  label: string;
  entityId?: string;
  page?: number;
}

export interface AssistantNavigationAction {
  label: string;
  page: string;
  params?: Record<string, unknown>;
}

export interface AssistantChatResponse {
  conversationId: string;
  messageId: string;
  status: AssistantResponseStatus;
  answer: string;
  citations: AssistantCitation[];
  navigation: AssistantNavigationAction[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Tool contract (section 15)
// ---------------------------------------------------------------------------

export type AssistantToolScopeType = "none" | "organization" | "property" | "portfolio";
export type AssistantToolAccessType = "product_knowledge" | "business_data";

export interface AssistantToolContext {
  req: Request;
  orgId: string;
  userId: string;
  supabaseAdmin: any;
}

export interface AssistantToolResult<T = unknown> {
  status: "answered" | "no_data" | "error";
  data: T | null;
  citations?: AssistantCitation[];
  navigation?: AssistantNavigationAction[];
  /** Human-safe note used when status is no_data/error — never raw error internals. */
  message?: string;
}

export interface AssistantTool<TArgs = any, TResult = unknown> {
  name: string;
  description: string;
  /** JSON Schema (object type, additionalProperties:false) describing args. */
  inputSchema: Record<string, unknown>;
  /** Page names checked via assertPageAccess(req, orgId, requiredPages, "read"). Empty = product-knowledge tool, no page gate. */
  requiredPages: string[];
  scopeType: AssistantToolScopeType;
  /** Which key in `args` holds the property/portfolio id to authorize, when scopeType requires one. */
  scopeArgKey?: string;
  accessType: AssistantToolAccessType;
  execute(args: TArgs, ctx: AssistantToolContext): Promise<AssistantToolResult<TResult>>;
}

// ---------------------------------------------------------------------------
// Orchestrator turn envelope (section 19) — the strict structured-output
// schema the Assistant LLM must conform to on every turn.
// ---------------------------------------------------------------------------

export type AssistantTurnDecision =
  | { type: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | {
      type: "final";
      status: AssistantResponseStatus;
      answer: string;
      citations: AssistantCitation[];
      navigation: AssistantNavigationAction[];
      limitations: string[];
    };

export const ASSISTANT_TURN_SCHEMA_NAME = "assistant_turn_v1";

export function buildAssistantTurnJsonSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "tool_call", "final"],
    properties: {
      type: { type: "string", enum: ["tool_call", "final"] },
      tool_call: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["tool", "arguments"],
        properties: {
          tool: { type: "string", enum: toolNames },
          arguments: { type: "string" }, // JSON-encoded object string (strict mode can't do open-ended objects)
        },
      },
      final: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["status", "answer", "citations", "navigation", "limitations"],
        properties: {
          status: {
            type: "string",
            enum: ["answered", "access_denied", "no_data", "insufficient_evidence", "unsupported", "error"],
          },
          answer: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "label", "entityId", "page"],
              properties: {
                type: { type: "string" },
                label: { type: "string" },
                entityId: { type: ["string", "null"] },
                page: { type: ["number", "null"] },
              },
            },
          },
          navigation: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "page"],
              properties: {
                label: { type: "string" },
                page: { type: "string" },
              },
            },
          },
          limitations: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}


