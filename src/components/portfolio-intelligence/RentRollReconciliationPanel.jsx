import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function RentRollReconciliationPanel({ findings = [] }) {
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm">Rent Roll Reconciliation</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {findings.length === 0 ? <div className="text-xs text-slate-500">No material variances loaded.</div> : findings.slice(0, 6).map((finding) => <div key={`${finding.factId}-${finding.fieldKey}-${finding.class}`} className="rounded-md border p-2 text-xs"><span className="font-semibold">{finding.class}</span> {finding.fieldKey}</div>)}
        <div className="text-[11px] text-slate-400">Release 8 reconciliation is advisory only; no operational write-back is performed.</div>
      </CardContent>
    </Card>
  );
}
