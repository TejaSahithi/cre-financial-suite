// @ts-nocheck
/**
 * navigation-tools.ts — section 16 "NAVIGATION". Returns where in the app to
 * go for a given page + already-authorized entity ids. Never mutates
 * anything; params are just the entity ids the model already has from the
 * page/tool context (they are not re-validated here — this tool produces a
 * navigation hint, not a data read, so it does not need scope authorization).
 */
import type { AssistantTool } from "../assistant-contracts.ts";
import { getCapabilityByPage } from "../capabilities/platform-capability-registry.ts";

export const getPageNavigationTargetTool: AssistantTool = {
  name: "get_page_navigation_target",
  description:
    "Get a navigation target (page + label) for suggesting where the user should go next, e.g. after explaining a blocker. Provide the target page name and, optionally, an entity id to carry over (e.g. propertyId, leaseId).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["page"],
    properties: {
      page: { type: "string", description: "Target page name, e.g. \"LeaseExpenseClassification\"." },
      entity_id: { type: "string", description: "Optional entity id to carry over as a navigation param (e.g. the propertyId or leaseId already in context)." },
      entity_param_name: { type: "string", description: "Optional param name for entity_id, e.g. \"propertyId\"." },
    },
  },
  requiredPages: [],
  scopeType: "none",
  accessType: "product_knowledge",
  async execute(args) {
    const page = String(args.page ?? "");
    const capability = getCapabilityByPage(page);
    const label = capability ? `Open ${capability.label}` : `Open ${page}`;
    const params: Record<string, unknown> = {};
    if (args.entity_id && args.entity_param_name) {
      params[String(args.entity_param_name)] = args.entity_id;
    }
    return {
      status: "answered",
      data: { label, page, params },
      navigation: [{ label, page, params }],
    };
  },
};

export const navigationTools: AssistantTool[] = [getPageNavigationTargetTool];
