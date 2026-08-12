import { createContext, useContext, useEffect } from "react";

/** Created here, provided by AssistantContextProvider.jsx — kept in a
 * separate module so both files can import it without a circular import. */
export const AssistantStateContext = createContext(null);

export function useAssistantContext() {
  const ctx = useContext(AssistantStateContext);
  if (!ctx) {
    throw new Error("useAssistantContext must be used within AssistantContextProvider");
  }
  return ctx;
}

/**
 * Convenience hook for a page to declare what the Assistant should treat as
 * "this" — e.g. useAssistantPageContext({ page: "LeaseExpenseClassification",
 * entities: { propertyId, expenseId } }). Only entity IDs are sent (section
 * 18: never full page state or record datasets); the server re-authorizes
 * every ID regardless of what the page claims.
 */
export function useAssistantPageContext(partial) {
  const { setPageContext } = useAssistantContext();
  const key = JSON.stringify(partial ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPageContext(partial ?? {});
  }, [key]);
}
