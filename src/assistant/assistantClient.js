import { invokeEdgeFunction } from "@/services/edgeFunctions";

/**
 * Thin client for assistant-chat-v1. Reuses invokeEdgeFunction (already
 * handles session refresh, the x-acting-org-id header for super-admins, and
 * error normalization) rather than duplicating that logic — see
 * src/services/edgeFunctions.js.
 */
export async function sendAssistantMessage({ conversationId, message, context }) {
  return invokeEdgeFunction("assistant-chat-v1", {
    conversationId: conversationId ?? null,
    message,
    context: context ?? {},
  });
}
