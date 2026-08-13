import React, { useState } from "react";
import { Bot, FileText, Send, RotateCcw, MapPin } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useAssistantContext } from "./useAssistantContext";

const STATUS_LABEL = {
  access_denied: "Access restricted",
  no_data: "No data yet",
  insufficient_evidence: "Insufficient evidence",
  unsupported: "Read-only",
  error: "Error",
};

const SUGGESTIONS_BY_PAGE = {
  LeaseReview: ["Summarize this lease", "What are the important dates?", "Explain the recovery rules"],
  LeaseExpenseClassification: ["Why is this blocked?", "Is this CAM eligible?", "Show supporting lease evidence"],
  CAMRun: ["Explain this CAM result", "What is blocking readiness?", "Why did this tenant's recovery change?"],
  CAMApproval: ["Explain this CAM result", "What is blocking readiness?"],
  BudgetDashboard: ["What is this budget based on?", "Explain the largest variance", "Which assumptions affect this amount?"],
  CreateBudget: ["What is this budget based on?", "Which assumptions affect this amount?"],
};
const DEFAULT_SUGGESTIONS = ["What does this page do?", "What should I do next?"];

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[90%] items-start gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
        {!isUser && (
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--pf-shell-border)] bg-[var(--pf-blue-soft)] text-[var(--accent)]" aria-hidden="true">
            <Bot className="h-4 w-4" />
          </div>
        )}
        <div className={`max-w-full rounded-lg px-3 py-2 text-sm ${isUser ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
          <p className="whitespace-pre-wrap">{message.content}</p>
          {!isUser && message.status && message.status !== "answered" && (
            <Badge variant="outline" className="mt-2">{STATUS_LABEL[message.status] || message.status}</Badge>
          )}
          {!isUser && message.citations?.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
              {message.citations.map((c, i) => (
                <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  <span>{c.label}{c.page ? ` (p. ${c.page})` : ""}</span>
                </div>
              ))}
            </div>
          )}
          {!isUser && message.navigation?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.navigation.map((nav, i) => (
                <Badge key={i} variant="secondary" className="cursor-default"><MapPin className="mr-1 h-3 w-3" />{nav.label}</Badge>
              ))}
            </div>
          )}
          {!isUser && message.limitations?.length > 0 && (
            <div className="mt-2 text-xs italic text-muted-foreground">{message.limitations.join(" ")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AssistantPanel() {
  const { isOpen, setIsOpen, pageContext, messages, isSending, sendMessage, clearConversation } = useAssistantContext();
  const [draft, setDraft] = useState("");

  const suggestions = SUGGESTIONS_BY_PAGE[pageContext?.page] || DEFAULT_SUGGESTIONS;

  const handleSend = (text) => {
    const value = text ?? draft;
    if (!value.trim() || isSending) return;
    sendMessage(value);
    setDraft("");
  };

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-16 w-16 rounded-full border border-[var(--pf-shell-border)] bg-gradient-to-br from-white to-[var(--pf-blue-soft)] p-0 text-[var(--accent)] shadow-[0_16px_34px_rgba(20,86,199,.28)] hover:from-white hover:to-[var(--pf-blue-soft)]"
        aria-label="Open ProForma Assistant"
      >
        <Bot className="h-9 w-9" />
      </Button>

      <Sheet open={isOpen} onOpenChange={setIsOpen} modal={false}>
        <SheetContent side="right" showOverlay={false} className="flex w-full flex-col border-l bg-background/95 shadow-2xl backdrop-blur sm:max-w-[420px]">
          <SheetHeader>
            <div className="flex items-center justify-between pr-6">
              <SheetTitle className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--pf-shell-border)] bg-[var(--pf-blue-soft)] text-[var(--accent)]">
                  <Bot className="h-4 w-4" />
                </span>
                ProForma Assistant
              </SheetTitle>
              <Button variant="ghost" size="sm" onClick={clearConversation} title="New conversation">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="flex-1 space-y-3 overflow-y-auto py-4">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Ask about anything in the platform: what a page does, why something is blocked, or how a number was calculated.</p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <Button key={s} variant="outline" size="sm" onClick={() => handleSend(s)} disabled={isSending}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {isSending && <div className="text-sm text-muted-foreground">Thinking...</div>}
          </div>

          <div className="flex items-end gap-2 border-t pt-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask a question..."
              className="min-h-[44px] resize-none"
              disabled={isSending}
            />
            <Button onClick={() => handleSend()} disabled={isSending || !draft.trim()} size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
