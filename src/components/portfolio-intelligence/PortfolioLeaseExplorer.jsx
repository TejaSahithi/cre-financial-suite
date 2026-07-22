import React, { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PortfolioLeaseExplorer({ leases = [] }) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => leases.filter((lease) => [lease.tenantName, lease.propertyName, lease.riskSeverity, lease.reviewStatus].some((value) => String(value || "").toLowerCase().includes(filter.toLowerCase()))), [leases, filter]);
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm">Lease Explorer</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by tenant, property, risk, or review status" className="h-9" />
        <div className="space-y-2 max-h-64 overflow-auto">
          {filtered.slice(0, 25).map((lease) => <div key={lease.id || lease.documentFamilyId} className="grid grid-cols-4 gap-2 rounded-md border border-slate-200 p-2 text-xs"><span className="font-medium truncate">{lease.tenantName || "Unknown"}</span><span className="truncate text-slate-500">{lease.propertyName || "Unassigned"}</span><span className="truncate text-slate-500">{lease.expirationDate || "No expiration"}</span><span className="truncate text-slate-500">{lease.riskSeverity || "none"}</span></div>)}
        </div>
      </CardContent>
    </Card>
  );
}
