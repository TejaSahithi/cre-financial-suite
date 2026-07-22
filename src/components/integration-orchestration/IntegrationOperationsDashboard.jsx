import React from "react";
import { AlertTriangle, Bell, GitBranch, Plug, RefreshCw, ShieldCheck, Workflow } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const rows = [
  { label: "Event Bus", value: "Immutable", icon: GitBranch, tone: "bg-blue-50 text-blue-700", note: "lease and portfolio facts publish versioned events" },
  { label: "Workflows", value: "Routed", icon: Workflow, tone: "bg-indigo-50 text-indigo-700", note: "role, team, queue, and user assignments" },
  { label: "Webhooks", value: "Signed", icon: ShieldCheck, tone: "bg-emerald-50 text-emerald-700", note: "HMAC signatures, replay windows, retries" },
  { label: "Connectors", value: "Read-only", icon: Plug, tone: "bg-slate-50 text-slate-700", note: "ERP, CMMS, CRM, DMS, calendar contracts" },
];

export default function IntegrationOperationsDashboard() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {rows.map((row) => {
          const Icon = row.icon;

          return (
            <Card key={row.label} className="rounded-lg border-slate-200 shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">{row.label}</p>
                    <p className="text-lg font-semibold text-slate-900">{row.value}</p>
                  </div>
                  <div className={`rounded-md p-2 ${row.tone}`}><Icon className="h-4 w-4" /></div>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">{row.note}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="rounded-lg border-slate-200 shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Operational Orchestration</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><RefreshCw className="h-4 w-4" />Retry Queue</div>
            <p className="mt-1 text-xs text-slate-500">HTTP 408, 429, and 5xx failures retry with exponential backoff. Validation and permission failures stop immediately.</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><AlertTriangle className="h-4 w-4" />Dead Letters</div>
            <p className="mt-1 text-xs text-slate-500">Failed payloads retain retry history and recovery action for replay after correction.</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Bell className="h-4 w-4" />Notifications</div>
            <p className="mt-1 text-xs text-slate-500">Email, in-app, webhook, Slack, and Teams templates are driven by approved facts and workflow events.</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {['lease.approved', 'portfolio-snapshot.published', 'risk.created', 'rent-roll-variance.detected', 'critical-date.created'].map((event) => (
          <Badge key={event} variant="outline" className="bg-white text-slate-600">{event}</Badge>
        ))}
      </div>
    </div>
  );
}
