// @ts-nocheck
/**
 * tool-registry.ts — the CLOSED set of tools the Assistant LLM may call
 * (section 15: "Never execute a tool name invented by GPT. GPT can only
 * call registered tools."). The orchestrator builds its JSON-schema `enum`
 * of allowed tool names directly from this map's keys, so an unregistered
 * name is not merely rejected at execution time — the model's own output
 * schema makes it structurally impossible to emit one via strict
 * json_schema mode.
 */
import type { AssistantTool } from "../assistant-contracts.ts";
import { productTools } from "./product-tools.ts";
import { propertyTools } from "./property-tools.ts";
import { leaseTools } from "./lease-tools.ts";
import { tenantTools } from "./tenant-tools.ts";
import { expenseTools } from "./expense-tools.ts";
import { camTools } from "./cam-tools.ts";
import { revenueTools } from "./revenue-tools.ts";
import { budgetTools } from "./budget-tools.ts";
import { workflowTools } from "./workflow-tools.ts";
import { navigationTools } from "./navigation-tools.ts";

const ALL_TOOLS: AssistantTool[] = [
  ...productTools,
  ...propertyTools,
  ...leaseTools,
  ...tenantTools,
  ...expenseTools,
  ...camTools,
  ...revenueTools,
  ...budgetTools,
  ...workflowTools,
  ...navigationTools,
];

export const TOOL_REGISTRY: ReadonlyMap<string, AssistantTool> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getToolNames(): string[] {
  return [...TOOL_REGISTRY.keys()];
}

export function getTool(name: string): AssistantTool | undefined {
  return TOOL_REGISTRY.get(name);
}

/** Compact catalog (name + description + args) for the system prompt — kept
 * small deliberately (section 26: don't spend tokens on unlimited context). */
export function describeToolsForPrompt(): string {
  return ALL_TOOLS.map((t) => {
    const required = (t.inputSchema.required ?? []) as string[];
    return `- ${t.name}(${required.join(", ")}): ${t.description}`;
  }).join("\n");
}
