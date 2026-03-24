import React from "react";
import { CAMCalculationService, PropertyService, LeaseService, ExpenseService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, RadarChart, PolarGrid, PolarAngleAxis, Radar } from "recharts";
import { TrendingUp, Building2, DollarSign, Calculator } from "lucide-react";

const COLORS = ["#1a2744","#3b82f6","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4"];

export default function Analytics() {
  const { data: properties = [] } = useQuery({ queryKey: ['properties'], queryFn: () => PropertyService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list() });
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => ExpenseService.list() });
  const { data: camCalcs = [] } = useQuery({ queryKey: ['cam-calcs'], queryFn: () => CAMCalculationService.list() });

  const totalSF = properties.reduce((s, p) => s + (p.total_sf || 0), 0);
  const totalRevenue = leases.filter(l => l.status !== 'expired').reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const totalCAM = camCalcs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const avgOccupancy = properties.length ? (properties.reduce((s, p) => s + (p.occupancy_pct || 0), 0) / properties.length) : 0;
  const camRecovery = totalExpenses ? ((totalCAM / totalExpenses) * 100) : 0;
  const noiMargin = totalRevenue ? (((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0;
  const revenuePerSF = totalSF ? (totalRevenue / totalSF) : 0;
  const expensePerSF = totalSF ? (totalExpenses / totalSF) : 0;

  const kpis = [
    { label: "Revenue / SqFt", value: `$${revenuePerSF.toFixed(2)}`, icon: DollarSign, color: "bg-blue-50 text-blue-600" },
    { label: "Expense / SqFt", value: `$${expensePerSF.toFixed(2)}`, icon: DollarSign, color: "bg-red-50 text-red-600" },
    { label: "CAM Recovery %", value: `${camRecovery.toFixed(1)}%`, icon: Calculator, color: "bg-purple-50 text-purple-600" },
    { label: "Occupancy %", value: `${avgOccupancy.toFixed(1)}%`, icon: Building2, color: "bg-emerald-50 text-emerald-600" },
    { label: "NOI Margin", value: `${noiMargin.toFixed(1)}%`, icon: TrendingUp, color: "bg-amber-50 text-amber-600" },
  ];

  // Property type distribution
  const typeDistrib = {};
  properties.forEach(p => { typeDistrib[p.property_type || 'unknown'] = (typeDistrib[p.property_type || 'unknown'] || 0) + 1; });
  const typeData = Object.entries(typeDistrib).map(([name, value]) => ({ name, value }));

  // Radar data
  const radarData = [
    { metric: 'Revenue/SF', value: Math.min(revenuePerSF / 50 * 100, 100) },
    { metric: 'Occupancy', value: avgOccupancy },
    { metric: 'CAM Recovery', value: camRecovery },
    { metric: 'NOI Margin', value: noiMargin },
    { metric: 'Expense Eff.', value: Math.max(100 - (expensePerSF / 30 * 100), 0) },
  ];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
        <p className="text-sm text-slate-500">Advanced portfolio performance metrics</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {kpis.map((k, i) => (
          <Card key={i}><CardContent className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${k.color}`}><k.icon className="w-5 h-5" /></div>
            <div><p className="text-[9px] font-semibold text-slate-500 uppercase">{k.label}</p><p className="text-lg font-bold">{k.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Radar */}
        <Card>
          <CardHeader><CardTitle className="text-base">Portfolio Health Score</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <RadarChart data={radarData}>
                <PolarGrid strokeDasharray="3 3" />
                <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11 }} />
                <Radar name="Score" dataKey="value" stroke="#1a2744" fill="#1a2744" fillOpacity={0.2} />
              </RadarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Property Type Distribution */}
        <Card>
          <CardHeader><CardTitle className="text-base">Property Type Distribution</CardTitle></CardHeader>
          <CardContent>
            {typeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={typeData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}>
                    {typeData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="text-sm text-slate-400 text-center py-12">No property data</p>}
          </CardContent>
        </Card>
      </div>

      {/* Expense Benchmark */}
      <Card>
        <CardHeader><CardTitle className="text-base">Expense Benchmark by Category ($/SqFt)</CardTitle></CardHeader>
        <CardContent>
          {(() => {
            const catSF = {};
            expenses.forEach(e => { catSF[e.category || 'other'] = (catSF[e.category || 'other'] || 0) + (e.amount || 0); });
            const benchData = Object.entries(catSF).map(([cat, total]) => ({ category: cat.replace(/_/g, ' '), perSF: totalSF ? +(total / totalSF).toFixed(2) : 0 })).sort((a, b) => b.perSF - a.perSF).slice(0, 10);
            return (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={benchData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
                  <YAxis type="category" dataKey="category" width={130} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={v => `$${v}/SF`} />
                  <Bar dataKey="perSF" fill="#3b82f6" name="$/SqFt" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}