import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Network } from "lucide-react";

function Metric({ label, value, tone = "slate" }) {
  const toneClass = tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-800" : tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase text-current/70">{label}</div>
      <div className="mt-0.5 text-xl font-bold">{value ?? 0}</div>
    </div>
  );
}

export default function SemanticCoveragePanel({ semanticCoverage, definitions = [], crossReferences = [] }) {
  if (!semanticCoverage && definitions.length === 0 && crossReferences.length === 0) return null;
  const unresolved = Number(semanticCoverage?.crossReferencesUnresolved ?? 0) + Number(semanticCoverage?.amendmentEffectsUnresolved ?? 0) + Number(semanticCoverage?.definitionsConflicting ?? 0);

  return (
    <Card className="mb-4 border-slate-200 bg-white shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Network className="h-4 w-4 text-blue-600" /> Semantic Coverage
          </CardTitle>
          <Badge variant="outline" className={unresolved > 0 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>
            {unresolved > 0 ? `${unresolved} open semantic issue${unresolved === 1 ? "" : "s"}` : "Semantics resolved"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 pt-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Definitions" value={semanticCoverage?.definitionsDetected ?? definitions.length} />
        <Metric label="Resolved Defs" value={semanticCoverage?.definitionsResolved} tone="ok" />
        <Metric label="Cross Refs" value={semanticCoverage?.crossReferencesDetected ?? crossReferences.length} />
        <Metric label="Resolved Refs" value={semanticCoverage?.crossReferencesResolved} tone="ok" />
        <Metric label="Amendments" value={semanticCoverage?.amendmentsDetected} />
        <Metric label="Open" value={unresolved} tone={unresolved > 0 ? "warn" : "ok"} />
      </CardContent>
    </Card>
  );
}