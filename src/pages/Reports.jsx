import React from "react";
import { expenseService } from "@/services/expenseService";
import { leaseService } from "@/services/leaseService";
import { propertyService } from "@/services/propertyService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Line, PieChart, Pie, Cell } from "recharts";
import { Download, TrendingUp, BarChart3, FileText, DollarSign, Calculator, Building2 } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const COLORS = ["#1a2744","#3b82f6","#10b981","#f59e0b","#8b5cf6","#ef4444","#94a3b8"];

const reportTypes = [
  { name: "Rent Roll", desc: "Complete rent roll across all properties", icon: FileText, page: "RentProjection" },
  { name: "CAM Statement", desc: "CAM allocation and tenant charges", icon: Calculator, page: "CAMDashboard" },
  { name: "Expense Report", desc: "Detailed expense breakdown by category", icon: DollarSign, page: "Expenses" },
  { name: "Budget Report", desc: "Budget summary with variance analysis", icon: BarChart3, page: "BudgetDashboard" },
  { name: "Variance Report", desc: "Budget vs actual variance details", icon: TrendingUp, page: "Variance" },
  { name: "NOI Report", desc: "Net operating income analysis", icon: Building2, page: "Actuals" },
  { name: "Portfolio Summary", desc: "High-level portfolio performance overview", icon: BarChart3, page: "Portfolios" },
];

export default function Reports() {
  const { data: properties = [] } = useQuery({ queryKey: ['properties'], queryFn: () => propertyService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => leaseService.list() });
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => expenseService.list() });

  const activeLeases = leases.filter(l => l.status !== 'expired');
  const totalRevenue = activeLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const noi = totalRevenue - totalExpenses;
  const totalSF = properties.reduce((s, p) => s + (p.total_sf || 0), 0);
  const avgOccupancy = properties.length ? (properties.reduce((s, p) => s + (p.occupancy_pct || 0), 0) / properties.length) : 0;

  const hasData = properties.length > 0 || leases.length > 0 || expenses.length > 0;

  // Build expense pie
  const expByCat = {};
  expenses.forEach(e => { expByCat[e.category || 'other'] = (expByCat[e.category || 'other'] || 0) + (e.amount || 0); });
  const pieData = Object.entries(expByCat).map(([name, value]) => ({ name: name.replace(/_/g, ' '), value }));

  // Monthly aggregation
  const monthlyRent = activeLeases.reduce((s, l) => s + (l.base_rent || 0), 0);
  const expByMonth = {};
  expenses.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) expByMonth[m] = (expByMonth[m] || 0) + (e.amount || 0);
  });
  const chartData = MONTHS.map((month, i) => ({
    month,
    revenue: monthlyRent,
    expenses: expByMonth[i + 1] || 0,
    noi: monthlyRent - (expByMonth[i + 1] || 0),
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports & KPIs</h1>
          <p className="text-sm text-slate-500">Raw operational preview metrics and links to authoritative report pages</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline"><Download className="w-4 h-4 mr-2" />Export</Button>
        </div>
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="p-4">
          <p className="text-sm font-semibold text-amber-900">Preview analytics only</p>
          <p className="mt-1 text-xs text-amber-700">
            This page summarizes raw stored records for quick operational review. For authoritative
            computed outputs, use the Rent Projection, CAM Dashboard, Budget Dashboard, and Reconciliation pages.
          </p>
        </CardContent>
      </Card>

      {/* KPIs from real data */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "NOI", value: hasData ? `$${(noi/1000).toFixed(0)}K` : "—", sub: "Net Operating Income" },
          { label: "Occupancy", value: hasData ? `${avgOccupancy.toFixed(1)}%` : "—", sub: "Average Occupancy" },
          { label: "Revenue/SqFt", value: totalSF ? `$${(totalRevenue / totalSF).toFixed(2)}` : "—", sub: "Annual Revenue per SF" },
          { label: "Expense Ratio", value: totalRevenue ? `${((totalExpenses / totalRevenue) * 100).toFixed(1)}%` : "—", sub: "Expenses / Revenue" },
        ].map((kpi, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold text-slate-500 uppercase">{kpi.label}</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{kpi.value}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{kpi.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts - only render if data exists */}
      {hasData ? (
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle className="text-base">Revenue / Expenses / NOI — Monthly</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
                  <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                  <Legend />
                  <Area type="monotone" dataKey="revenue" stroke="#1a2744" fill="#1a2744" fillOpacity={0.15} name="Revenue" />
                  <Area type="monotone" dataKey="expenses" stroke="#ef4444" fill="#ef4444" fillOpacity={0.1} name="Expenses" />
                  <Line type="monotone" dataKey="noi" stroke="#10b981" strokeWidth={2} name="NOI" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Expense Breakdown</CardTitle></CardHeader>
            <CardContent>
              {pieData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value">
                        {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-2 gap-1 mt-2">
                    {pieData.slice(0, 6).map((d, i) => (
                      <div key={d.name} className="flex items-center gap-1.5 text-[10px]">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span className="text-slate-600 capitalize truncate">{d.name}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-400 text-center py-12">No expenses yet</p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <BarChart3 className="w-12 h-12 text-slate-200 mx-auto mb-4" />
            <p className="text-lg font-medium text-slate-400">No data to report yet</p>
            <p className="text-sm text-slate-300 mt-1">Add properties, leases, and expenses to generate reports</p>
          </CardContent>
        </Card>
      )}

      {/* Report types */}
      <Card>
        <CardHeader><CardTitle className="text-base">Available Reports</CardTitle></CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {reportTypes.map((r, i) => (
              <Link key={i} to={createPageUrl(r.page)} className="flex items-center gap-3 p-4 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors group">
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center group-hover:bg-blue-50">
                  <r.icon className="w-5 h-5 text-slate-500 group-hover:text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">{r.name}</p>
                  <p className="text-xs text-slate-400">{r.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
