import React from "react";
import { expenseService } from "@/services/expenseService";
import { leaseService } from "@/services/leaseService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Line } from "recharts";
import { DollarSign, TrendingUp, Layers, BarChart3 } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function Actuals() {
  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseService.list(),
  });

  const { data: leases = [] } = useQuery({
    queryKey: ['leases'],
    queryFn: () => leaseService.list(),
  });

  const activeLeases = leases.filter(l => l.status !== 'expired');
  const monthlyRent = activeLeases.reduce((s, l) => s + (l.base_rent || 0), 0);

  // Monthly expense aggregation
  const monthlyExpenses = {};
  expenses.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) monthlyExpenses[m] = (monthlyExpenses[m] || 0) + (e.amount || 0);
  });

  const chartData = MONTHS.map((name, i) => {
    const exp = monthlyExpenses[i + 1] || 0;
    return { month: name, revenue: monthlyRent, expenses: exp, noi: monthlyRent - exp };
  });

  const totalRevenue = monthlyRent * 12;
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Actuals</h1>
        <p className="text-sm text-slate-500">Actual financial data for the current fiscal year</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "YTD Revenue", value: `$${(totalRevenue/1000).toFixed(0)}K`, icon: TrendingUp, color: "bg-blue-50 text-blue-600" },
          { label: "YTD Expenses", value: `$${(totalExpenses/1000).toFixed(0)}K`, icon: DollarSign, color: "bg-red-50 text-red-600" },
          { label: "YTD NOI", value: `$${((totalRevenue-totalExpenses)/1000).toFixed(0)}K`, icon: Layers, color: "bg-emerald-50 text-emerald-600" },
          { label: "NOI Margin", value: totalRevenue ? `${(((totalRevenue-totalExpenses)/totalRevenue)*100).toFixed(1)}%` : '0%', icon: BarChart3, color: "bg-purple-50 text-purple-600" },
        ].map((s, i) => (
          <Card key={i}><CardContent className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div><p className="text-[10px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-xl font-bold">{s.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {/* Chart */}
      <Card>
        <CardHeader><CardTitle className="text-base">Monthly Actuals — Revenue, Expenses, NOI</CardTitle></CardHeader>
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

      {/* Table */}
      <Card>
        <CardHeader><CardTitle className="text-base">Monthly Breakdown</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">MONTH</TableHead>
                <TableHead className="text-[11px] text-right">REVENUE</TableHead>
                <TableHead className="text-[11px] text-right">EXPENSES</TableHead>
                <TableHead className="text-[11px] text-right">NOI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chartData.map(row => (
                <TableRow key={row.month}>
                  <TableCell className="font-medium">{row.month}</TableCell>
                  <TableCell className="text-right font-mono">${row.revenue.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono">${row.expenses.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">${row.noi.toLocaleString()}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-slate-50 font-bold">
                <TableCell>Annual Total</TableCell>
                <TableCell className="text-right font-mono">${totalRevenue.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono">${totalExpenses.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono">${(totalRevenue - totalExpenses).toLocaleString()}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}