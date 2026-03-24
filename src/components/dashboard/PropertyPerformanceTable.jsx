import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ChevronRight, Building2 } from "lucide-react";

const statusBadge = {
  active: "bg-emerald-100 text-emerald-700",
  draft: "bg-slate-100 text-slate-600",
  archived: "bg-red-100 text-red-700",
};

function fmt(v) {
  if (!v) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export default function PropertyPerformanceTable({ properties = [], leases = [], expenses = [], camCalcs = [] }) {
  const rows = properties.map(p => {
    const pLeases = leases.filter(l => l.property_id === p.id && l.status !== 'expired');
    const pExpenses = expenses.filter(e => e.property_id === p.id);
    const pCAM = camCalcs.filter(c => c.property_id === p.id);
    const revenue = pLeases.reduce((s, l) => s + (l.annual_rent || (l.base_rent || 0) * 12), 0) + pCAM.reduce((s, c) => s + (c.annual_cam || 0), 0);
    const exp = pExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    const occ = p.total_sf > 0 ? ((p.leased_sf || 0) / p.total_sf * 100) : 0;
    return { ...p, revenue, exp, noi: revenue - exp, occ, leaseCount: pLeases.length };
  }).sort((a, b) => b.revenue - a.revenue);

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-4 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Property Performance</CardTitle>
          <p className="text-xs text-slate-500">{properties.length} properties · Revenue, expense, NOI per property</p>
        </div>
        <Link to={createPageUrl("Properties")} className="text-xs text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          All properties <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="text-left px-4 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">Property</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">Revenue</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">Expenses</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">NOI</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">Occ%</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">Leases</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map(r => (
                  <tr key={r.id} className="border-b border-slate-50 hover:bg-blue-50/30 transition-colors">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded bg-slate-100 flex items-center justify-center flex-shrink-0">
                          <Building2 className="w-3 h-3 text-slate-500" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-800 truncate max-w-[140px]">{r.name}</p>
                          <p className="text-xs text-slate-400">{r.city}{r.state ? `, ${r.state}` : ''} · {((r.total_sf || 0) / 1000).toFixed(0)}K SF</p>
                        </div>
                      </div>
                    </td>
                    <td className="text-right px-3 py-2 font-bold tabular-nums text-slate-800">{fmt(r.revenue)}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-slate-600">{fmt(r.exp)}</td>
                    <td className={`text-right px-3 py-2 font-bold tabular-nums ${r.noi >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmt(r.noi)}</td>
                    <td className="text-right px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-10 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${r.occ >= 90 ? 'bg-emerald-500' : r.occ >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(r.occ, 100)}%` }} />
                        </div>
                        <span className="tabular-nums font-semibold text-slate-700">{r.occ.toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="text-right px-3 py-2 text-slate-600">{r.leaseCount}</td>
                    <td className="px-2 py-2">
                      <Link to={`${createPageUrl("PropertyDetail")}?id=${r.id}`} className="text-blue-500 hover:text-blue-600">
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex items-center justify-center py-8 text-xs text-slate-400">
            <Building2 className="w-4 h-4 mr-2 text-slate-300" /> No property data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}