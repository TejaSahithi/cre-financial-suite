import React from "react";
import { CAMCalculationService, PropertyService, LeaseService, ExpenseService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { TrendingUp, TrendingDown, Building2, DollarSign, Target, ChevronRight } from "lucide-react";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#1e293b"];

export default function PortfolioInsights() {
  const { data: properties = [] } = useQuery({ queryKey: ['properties'], queryFn: () => PropertyService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list() });
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => ExpenseService.list() });
  const { data: camCalcs = [] } = useQuery({ queryKey: ['cam-calcs'], queryFn: () => CAMCalculationService.list() });

  const propertyMetrics = properties.map(p => {
    const pLeases = leases.filter(l => l.property_id === p.id && l.status !== 'expired');
    const pExp = expenses.filter(e => e.property_id === p.id);
    const pCAM = camCalcs.filter(c => c.property_id === p.id);
    const revenue = pLeases.reduce((s, l) => s + (l.annual_rent || (l.base_rent || 0) * 12), 0) + pCAM.reduce((s, c) => s + (c.annual_cam || 0), 0);
    const exp = pExp.reduce((s, e) => s + (e.amount || 0), 0);
    const occ = p.total_sf > 0 ? ((p.leased_sf || 0) / p.total_sf * 100) : 0;
    const expPerSF = p.total_sf > 0 ? exp / p.total_sf : 0;
    return { ...p, revenue, exp, noi: revenue - exp, occ, expPerSF, leaseCount: pLeases.length };
  });

  const totalRev = propertyMetrics.reduce((s, p) => s + p.revenue, 0);
  const topByNOI = [...propertyMetrics].sort((a, b) => b.noi - a.noi);
  const bottomByNOI = [...propertyMetrics].sort((a, b) => a.noi - b.noi);
  const byExpPerSF = [...propertyMetrics].filter(p => p.total_sf > 0).sort((a, b) => b.expPerSF - a.expPerSF);
  const revContribution = propertyMetrics.map(p => ({ name: p.name?.substring(0, 12), value: p.revenue, pct: totalRev > 0 ? (p.revenue / totalRev * 100) : 0 })).sort((a, b) => b.value - a.value);

  const fmt = (v) => { if (!v) return "$0"; if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`; if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`; return `$${v.toLocaleString()}`; };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2"><Target className="w-5 h-5 text-blue-600" /><h1 className="text-xl font-bold text-slate-900">Portfolio Insights</h1></div>
        <p className="text-xs text-slate-500">{properties.length} properties · Performance rankings, efficiency benchmarks, revenue analysis</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Top Performing */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1 pt-3 px-4"><CardTitle className="text-sm font-bold text-emerald-700 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" />Top Performing (by NOI)</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3 pt-1">
            <div className="space-y-2">
              {topByNOI.slice(0, 5).map((p, i) => (
                <Link key={p.id} to={`${createPageUrl("PropertyDetail")}?id=${p.id}`} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0 hover:bg-slate-50 rounded group">
                  <span className="text-xs font-bold text-slate-400 w-5">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{p.name}</p>
                    <p className="text-[10px] text-slate-400">{p.city}{p.state ? `, ${p.state}` : ''} · {((p.total_sf || 0) / 1000).toFixed(0)}K SF · {p.occ.toFixed(0)}% occ</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-emerald-700 tabular-nums">{fmt(p.noi)}</p>
                    <p className="text-[10px] text-slate-400">NOI</p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500" />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Lowest Performing */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1 pt-3 px-4"><CardTitle className="text-sm font-bold text-red-600 flex items-center gap-1.5"><TrendingDown className="w-4 h-4" />Lowest Performing (by NOI)</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3 pt-1">
            <div className="space-y-2">
              {bottomByNOI.slice(0, 5).map((p, i) => (
                <Link key={p.id} to={`${createPageUrl("PropertyDetail")}?id=${p.id}`} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0 hover:bg-slate-50 rounded group">
                  <span className="text-xs font-bold text-slate-400 w-5">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{p.name}</p>
                    <p className="text-[10px] text-slate-400">{p.city}{p.state ? `, ${p.state}` : ''} · {((p.total_sf || 0) / 1000).toFixed(0)}K SF</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold tabular-nums ${p.noi >= 0 ? 'text-slate-700' : 'text-red-600'}`}>{fmt(p.noi)}</p>
                    <p className="text-[10px] text-slate-400">NOI</p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500" />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Expense per SF */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1 pt-3 px-4"><CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-1.5"><DollarSign className="w-4 h-4 text-amber-600" />Expense per SF Comparison</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3 pt-1">
            {byExpPerSF.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={byExpPerSF.slice(0, 8).map(p => ({ name: p.name?.substring(0, 10), value: parseFloat(p.expPerSF.toFixed(2)) }))}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={v => `$${v}`} axisLine={false} tickLine={false} width={40} />
                  <Tooltip formatter={v => [`$${v}/SF`, 'Expense/SF']} contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={20}>
                    {byExpPerSF.slice(0, 8).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-slate-400 py-8 text-center">No property data</p>}
          </CardContent>
        </Card>

        {/* Revenue Contribution */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1 pt-3 px-4"><CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-1.5"><Building2 className="w-4 h-4 text-blue-600" />Revenue Contribution</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3 pt-1">
            <div className="space-y-2">
              {revContribution.slice(0, 6).map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-24 truncate">{p.name}</span>
                  <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(p.pct, 100)}%`, backgroundColor: COLORS[i % COLORS.length] }} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-700 w-16 text-right tabular-nums">{fmt(p.value)}</span>
                  <span className="text-[9px] text-slate-400 w-10 text-right">{p.pct.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}