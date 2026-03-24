import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowUp, ArrowDown } from "lucide-react";

export default function ComparisonTable({ rows, yearA, yearB, title = "Financial Comparison" }) {
  const totalA = rows.reduce((s, r) => s + r.yearA, 0);
  const totalB = rows.reduce((s, r) => s + r.yearB, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[11px]">METRIC</TableHead>
              <TableHead className="text-[11px] text-right bg-blue-50">{yearA}</TableHead>
              <TableHead className="text-[11px] text-right bg-emerald-50">{yearB}</TableHead>
              <TableHead className="text-[11px] text-right">CHANGE $</TableHead>
              <TableHead className="text-[11px] text-right">CHANGE %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const change = r.yearB - r.yearA;
              const pct = r.yearA ? ((change / Math.abs(r.yearA)) * 100).toFixed(1) : '—';
              const isUp = change > 0;
              return (
                <TableRow key={i}>
                  <TableCell className="font-medium text-sm capitalize">{r.label}</TableCell>
                  <TableCell className="text-right font-mono text-sm bg-blue-50/30">${r.yearA.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono text-sm bg-emerald-50/30">${r.yearB.toLocaleString()}</TableCell>
                  <TableCell className={`text-right font-mono text-sm ${isUp ? 'text-emerald-600' : change < 0 ? 'text-red-600' : ''}`}>
                    {change !== 0 && (isUp ? '+' : '')}${change.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {pct !== '—' && parseFloat(pct) !== 0 ? (
                      <Badge className={`${isUp ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'} text-[10px]`}>
                        {isUp ? <ArrowUp className="w-2.5 h-2.5 mr-0.5" /> : <ArrowDown className="w-2.5 h-2.5 mr-0.5" />}
                        {Math.abs(parseFloat(pct))}%
                      </Badge>
                    ) : <span className="text-xs text-slate-400">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length > 2 && (
              <TableRow className="bg-slate-50 font-bold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right font-mono">${totalA.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono">${totalB.toLocaleString()}</TableCell>
                <TableCell className={`text-right font-mono ${totalB - totalA > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {totalB - totalA > 0 ? '+' : ''}${(totalB - totalA).toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {totalA > 0 && (
                    <Badge className={totalB >= totalA ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>
                      {(((totalB - totalA) / totalA) * 100).toFixed(1)}%
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}