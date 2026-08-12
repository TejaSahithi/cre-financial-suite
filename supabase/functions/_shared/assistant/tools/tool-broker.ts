// @ts-nocheck
/**
 * tool-broker.ts — the ONLY code path that turns a model-requested tool name
 * into a real data retrieval (section 15). Every call goes:
 *   validate args against the tool's own schema
 *   -> authorize (page access, then property/portfolio scope access)
 *   -> execute
 *   -> return a compact, structured result
 *
 * The model can never reach a tool that isn't in TOOL_REGISTRY (see
 * tool-registry.ts) and can never skip the authorize step — there is no
 * "execute" path in this file that doesn't go through authorizeAndRunTool.
 */
import { assertPageAccess, assertPortfolioAccess, assertPropertyAccess } from "../../supabase.ts";
import type { AssistantTool, AssistantToolContext, AssistantToolResult } from "../assistant-contracts.ts";

export interface ToolRunRecord {
  tool_name: string;
  arguments: Record<string, unknown>;
  authorized: boolean;
  denial_reason: string | null;
  result_summary: Record<string, unknown>;
  latency_ms: number;
}

export interface ToolBrokerOutcome {
  authorized: boolean;
  /** Safe, user-facing denial classification — never leaks WHY beyond this. */
  denialKind?: "validation" | "page" | "property" | "portfolio";
  result: AssistantToolResult | null;
  runRecord: ToolRunRecord;
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema argument validator.
//
// Edge functions in this repo don't use a validation library (confirmed: no
// zod import anywhere under supabase/functions) — tool arg shapes here are
// deliberately simple (a handful of string/number/boolean properties), so a
// small hand-rolled checker matches existing repo convention rather than
// introducing a new dependency for a few lines of logic.
// ---------------------------------------------------------------------------
function validateArgs(schema: Record<string, any>, rawArgs: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  const args = rawArgs as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, any>;
  const required = (schema.required ?? []) as string[];
  const allowedKeys = new Set(Object.keys(properties));

  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `unexpected argument "${key}"` };
    }
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      return { ok: false, error: `missing required argument "${key}"` };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const propSchema = properties[key] ?? {};
    const expectedType = propSchema.type;
    const actualType = typeof value;
    if (expectedType === "string" && actualType !== "string") {
      return { ok: false, error: `argument "${key}" must be a string` };
    }
    if (expectedType === "number" && actualType !== "number") {
      return { ok: false, error: `argument "${key}" must be a number` };
    }
    if (expectedType === "boolean" && actualType !== "boolean") {
      return { ok: false, error: `argument "${key}" must be a boolean` };
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
      return { ok: false, error: `argument "${key}" must be one of: ${propSchema.enum.join(", ")}` };
    }
  }
  return { ok: true, value: args };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authorizeAndRunTool(
  tool: AssistantTool,
  rawArgs: unknown,
  ctx: AssistantToolContext,
): Promise<ToolBrokerOutcome> {
  const startedAt = Date.now();

  const validated = validateArgs(tool.inputSchema, rawArgs ?? {});
  if (!validated.ok) {
    return {
      authorized: false,
      denialKind: "validation",
      result: null,
      runRecord: {
        tool_name: tool.name,
        arguments: {},
        authorized: false,
        denial_reason: validated.error,
        result_summary: {},
        latency_ms: Date.now() - startedAt,
      },
    };
  }
  const args = validated.value;

  if (tool.requiredPages.length > 0) {
    try {
      await assertPageAccess(ctx.req, ctx.orgId, tool.requiredPages, "read");
    } catch {
      return {
        authorized: false,
        denialKind: "page",
        result: null,
        runRecord: {
          tool_name: tool.name,
          arguments: args,
          authorized: false,
          denial_reason: `page access denied: ${tool.requiredPages.join(", ")}`,
          result_summary: {},
          latency_ms: Date.now() - startedAt,
        },
      };
    }
  }

  if (tool.scopeType === "property" || tool.scopeType === "portfolio") {
    const scopeId = tool.scopeArgKey ? (args[tool.scopeArgKey] as string | undefined) : undefined;
    if (!scopeId || !UUID_RE.test(scopeId)) {
      return {
        authorized: false,
        denialKind: "validation",
        result: null,
        runRecord: {
          tool_name: tool.name,
          arguments: args,
          authorized: false,
          denial_reason: `missing/invalid ${tool.scopeArgKey ?? "scope"} id`,
          result_summary: {},
          latency_ms: Date.now() - startedAt,
        },
      };
    }
    try {
      if (tool.scopeType === "property") {
        await assertPropertyAccess(ctx.req, scopeId);
      } else {
        await assertPortfolioAccess(ctx.req, scopeId);
      }
    } catch {
      return {
        authorized: false,
        denialKind: tool.scopeType,
        result: null,
        runRecord: {
          tool_name: tool.name,
          arguments: args,
          authorized: false,
          denial_reason: `${tool.scopeType} access denied`,
          result_summary: {},
          latency_ms: Date.now() - startedAt,
        },
      };
    }
  }

  try {
    const result = await tool.execute(args, ctx);
    return {
      authorized: true,
      result,
      runRecord: {
        tool_name: tool.name,
        arguments: args,
        authorized: true,
        denial_reason: null,
        result_summary: { status: result.status, has_data: result.data != null },
        latency_ms: Date.now() - startedAt,
      },
    };
  } catch (error) {
    console.error(`[assistant tool-broker] ${tool.name} execution failed:`, error?.message ?? error);
    return {
      authorized: true,
      result: { status: "error", data: null, message: "This tool failed to retrieve data due to a technical error." },
      runRecord: {
        tool_name: tool.name,
        arguments: args,
        authorized: true,
        denial_reason: null,
        result_summary: { status: "error" },
        latency_ms: Date.now() - startedAt,
      },
    };
  }
}
