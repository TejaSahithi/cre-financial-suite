import React from "react";
import { Bot, FileSearch, GitBranch, HelpCircle, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const actions = [
  { label: "Ask about this lease", icon: Bot },
  { label: "Explain this field", icon: HelpCircle },
  { label: "Show evidence", icon: FileSearch },
  { label: "Explain amendment", icon: GitBranch },
  { label: "Executive summary", icon: Sparkles },
  { label: "Review blockers", icon: ListChecks },
];

export default function GroundedCopilotPanel({ scope = "lease" }) {
  return (
    <Card className="border-slate-200">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base"><Bot className="h-4 w-4" />Grounded Copilot</CardTitle>
          <Badge variant="outline" className="bg-white text-slate-600">{scope}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 md:grid-cols-3">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Button key={action.label} variant="outline" className="h-auto justify-start gap-2 py-2 text-left text-xs">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{action.label}</span>
              </Button>
            );
          })}
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="h-4 w-4" />Grounding Rules</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {["canonical fields", "reviewer overrides", "amendment precedence", "portfolio facts", "evidence citations", "org scoped"].map((item) => (
              <Badge key={item} variant="secondary" className="bg-white text-slate-600">{item}</Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Unsupported questions return limitations instead of inferred answers.</p>
        </div>
      </CardContent>
    </Card>
  );
}