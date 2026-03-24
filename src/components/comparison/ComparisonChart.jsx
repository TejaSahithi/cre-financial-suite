import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

export default function ComparisonChart({ title, data, yearA, yearB }) {
  const chartData = data.map(d => ({
    name: d.label.length > 15 ? d.label.substring(0, 15) + '…' : d.label,
    [yearA]: d.yearA,
    [yearB]: d.yearB,
  }));

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10 }} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend />
              <Bar dataKey={yearA} fill="#94a3b8" name={String(yearA)} radius={[0, 2, 2, 0]} />
              <Bar dataKey={yearB} fill="#3b82f6" name={String(yearB)} radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-slate-400 text-center py-12">No data to compare</p>
        )}
      </CardContent>
    </Card>
  );
}