import React from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { severityClass } from "@/lib/portfolio-intelligence/statusPresentation";

export default function PortfolioRiskDashboard({ risks, findings = [] }) {
  const severities = ["critical", "high", "medium", "low"];
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4" />Risk</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-4 gap-2">
          {severities.map((severity) => <div key={severity} className={`rounded-md border p-2 ${severityClass(severity)}`}><div className="text-[10px] uppercase">{severity}</div><div className="text-lg font-semibold">{risks.bySeverity?.[severity] || 0}</div></div>)}
        </div>
        <div className="text-xs text-slate-500">Explainable score: <span className="font-semibold text-slate-800">{risks.totalScore || 0}</span></div>
        <div className="space-y-2 max-h-48 overflow-auto">
          {findings.slice(0, 5).map((finding) => <div key={finding.id || finding.ruleKey} className="rounded-md border border-slate-200 p-2"><div className="text-xs font-semibold text-slate-800">{finding.ruleKey}</div><div className="text-xs text-slate-500">{finding.explanation}</div></div>)}
        </div>
      </CardContent>
    </Card>
  );
}
