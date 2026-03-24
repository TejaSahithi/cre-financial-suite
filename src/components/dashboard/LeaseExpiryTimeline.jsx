import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ChevronRight, AlertTriangle, Clock, Calendar } from "lucide-react";

export default function LeaseExpiryTimeline({ leases = [] }) {
  const now = new Date();
  const upcoming = leases
    .filter(l => l.end_date && l.status !== 'expired')
    .map(l => {
      const end = new Date(l.end_date);
      const daysLeft = Math.floor((end - now) / (1000 * 60 * 60 * 24));
      return { ...l, daysLeft, end };
    })
    .filter(l => l.daysLeft > 0 && l.daysLeft <= 365)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const urgent = upcoming.filter(l => l.daysLeft <= 90);
  const warning = upcoming.filter(l => l.daysLeft > 90 && l.daysLeft <= 180);

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Lease Expirations</CardTitle>
          <p className="text-[10px] text-slate-500">
            {urgent.length > 0 && <span className="text-red-600 font-bold">{urgent.length} critical (&lt;90d)</span>}
            {urgent.length > 0 && warning.length > 0 && " · "}
            {warning.length > 0 && <span className="text-amber-600 font-bold">{warning.length} upcoming (&lt;180d)</span>}
            {urgent.length === 0 && warning.length === 0 && "No expirations within 12 months"}
          </p>
        </div>
        <Link to={createPageUrl("Leases")} className="text-[10px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          All leases <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {upcoming.length > 0 ? (
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
            {upcoming.slice(0, 8).map((l, i) => (
              <div key={i} className="flex items-center gap-2.5 py-1.5 border-b border-slate-50 last:border-0">
                {l.daysLeft <= 90 ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                ) : l.daysLeft <= 180 ? (
                  <Clock className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700 truncate">{l.tenant_name}</p>
                  <p className="text-[10px] text-slate-400">
                    {l.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {l.annual_rent ? ` · $${(l.annual_rent / 1000).toFixed(0)}K/yr` : ''}
                  </p>
                </div>
                <Badge className={`text-[9px] font-bold px-1.5 py-0 ${l.daysLeft <= 90 ? 'bg-red-100 text-red-700' : l.daysLeft <= 180 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                  {l.daysLeft}d
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 py-4 text-center">No upcoming expirations</p>
        )}
      </CardContent>
    </Card>
  );
}