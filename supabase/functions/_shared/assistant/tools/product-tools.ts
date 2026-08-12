// @ts-nocheck
/**
 * product-tools.ts — pure product-knowledge tools (section 16 "PRODUCT").
 * No page gate, no scope, no customer data access: these answer "what does
 * this page do?" / "what happens when I do X?" purely from the capability
 * registry, so a user with zero module access can still get a generic
 * explanation of the product (section 7).
 */
import type { AssistantTool } from "../assistant-contracts.ts";
import {
  getCapabilityByPage,
  getWorkflowById,
  listCapabilitySummaries,
  listWorkflowSummaries,
} from "../capabilities/platform-capability-registry.ts";

export const getPageDefinitionTool: AssistantTool = {
  name: "get_page_definition",
  description:
    "Look up what a specific application page/feature does (purpose, prerequisites, downstream effects, related pages). Use for generic 'what does X do' / 'what is X used for' questions. Does not require any business-data access.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["page"],
    properties: {
      page: { type: "string", description: "Exact page name, e.g. \"CAMSetup\", \"LeaseExpenseClassification\", \"BudgetReview\"." },
    },
  },
  requiredPages: [],
  scopeType: "none",
  accessType: "product_knowledge",
  async execute(args) {
    const capability = getCapabilityByPage(String(args.page ?? ""));
    if (!capability) {
      return {
        status: "no_data",
        data: { available_pages: listCapabilitySummaries().map((c) => c.page) },
        message: `No capability definition found for page "${args.page}".`,
      };
    }
    return {
      status: "answered",
      data: capability,
      citations: [{ type: "capability", label: `Platform capability: ${capability.label}` }],
    };
  },
};

export const getWorkflowDefinitionTool: AssistantTool = {
  name: "get_workflow_definition",
  description:
    "Look up a cross-page business workflow (e.g. what happens end-to-end when an expense is sent to CAM, the CAM run lifecycle, the budget approval lifecycle). Use for 'what happens when I...' questions. Does not require any business-data access.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["workflow"],
    properties: {
      workflow: {
        type: "string",
        description: "Workflow id, e.g. \"send_to_cam\", \"lease_to_cam_ready\", \"cam_run_lifecycle\", \"budget_lifecycle\".",
      },
    },
  },
  requiredPages: [],
  scopeType: "none",
  accessType: "product_knowledge",
  async execute(args) {
    const workflow = getWorkflowById(String(args.workflow ?? ""));
    if (!workflow) {
      return {
        status: "no_data",
        data: { available_workflows: listWorkflowSummaries() },
        message: `No workflow definition found for "${args.workflow}".`,
      };
    }
    return {
      status: "answered",
      data: workflow,
      citations: [{ type: "capability", label: `Platform workflow: ${workflow.label}` }],
    };
  },
};

export const productTools: AssistantTool[] = [getPageDefinitionTool, getWorkflowDefinitionTool];
