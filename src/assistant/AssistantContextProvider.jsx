import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { getActiveOrgId } from "@/lib/rbac";
import { AssistantStateContext } from "./useAssistantContext";
import { sendAssistantMessage } from "./assistantClient";

export function AssistantContextProvider({ children }) {
  const { user } = useAuth();
  const activeOrgId = getActiveOrgId(user);

  const [pageContext, setPageContextState] = useState({});
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const lastOrgIdRef = useRef(activeOrgId);

  // Section 24: never reuse protected business context from a previous
  // organization — switching acting org starts a fresh conversation.
  useEffect(() => {
    if (lastOrgIdRef.current && activeOrgId && lastOrgIdRef.current !== activeOrgId) {
      setConversationId(null);
      setMessages([]);
    }
    lastOrgIdRef.current = activeOrgId;
  }, [activeOrgId]);

  const setPageContext = useCallback((partial) => {
    setPageContextState(partial ?? {});
  }, []);

  const clearConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
  }, []);

  const sendMessage = useCallback(
    async (text) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed || isSending) return;

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setIsSending(true);
      try {
        const requestContext = {
          currentPage: pageContext.page,
          route: typeof window !== "undefined" ? window.location.pathname : undefined,
          fiscalYear: typeof pageContext.fiscalYear === "number" ? pageContext.fiscalYear : undefined,
          entities: pageContext.entities ?? {},
          uiState: {
            selectedTab: pageContext.selectedTab,
            selectedIds: pageContext.selectedIds,
            filters: pageContext.filters,
          },
        };
        const response = await sendAssistantMessage({ conversationId, message: trimmed, context: requestContext });
        setConversationId(response.conversationId);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: response.answer,
            status: response.status,
            citations: response.citations ?? [],
            navigation: response.navigation ?? [],
            limitations: response.limitations ?? [],
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: err?.message || "Something went wrong reaching the Assistant.", status: "error", citations: [], navigation: [], limitations: [] },
        ]);
      } finally {
        setIsSending(false);
      }
    },
    [conversationId, pageContext, isSending],
  );

  const value = useMemo(
    () => ({ isOpen, setIsOpen, pageContext, setPageContext, conversationId, messages, isSending, sendMessage, clearConversation }),
    [isOpen, pageContext, setPageContext, conversationId, messages, isSending, sendMessage, clearConversation],
  );

  return <AssistantStateContext.Provider value={value}>{children}</AssistantStateContext.Provider>;
}
