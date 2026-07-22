import React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ApprovalReadinessSummary({ approval }) {
  if (!approval) return null;
  const metrics = [
    ["Blocking", approval.blockingCount],
    ["Warnings", approval.warningCount],
    ["Conflicts", approval.conflictCount],
    ["Missing Required", approval.missingRequiredCount],
    ["Missing Evidence", approval.missingEvidenceCount],
    ["Fallbacks", approval.fallbackCount],
    ["Overrides", approval.overrideCount],
  ];
  return (
    <Card className="rounded-md border-slate-200">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          Approval Readiness
          <Badge className={approval.eligible ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"}>
            {approval.eligible ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <AlertTriangle className="mr-1 h-3 w-3" />}
            {approval.eligible ? "Eligible" : "Review Required"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="rounded border border-slate-100 bg-slate-50 p-2">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-lg font-semibold text-slate-900">{value}</div>
          </div>
        ))}
        {approval.reasons?.length > 0 && <p className="col-span-full text-xs text-slate-600">{approval.reasons.join(", ")}</p>}
      </CardContent>
    </Card>
  );
}
