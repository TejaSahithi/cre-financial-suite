import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, TrendingUp, TrendingDown, Minus } from "lucide-react";
import RevenueSourcePopover from "./RevenueSourcePopover";

function fmt(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString()}`;
}

export default function PropertyRevenueTable({ propertyData, onSelectProperty }) {
  const sorted = [...propertyData].sort((a, b) => b.totalRevenue - a.totalRevenue);
  const grandTotal = sorted.reduce((s, p) => s + p.totalRevenue, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Property-Level Revenue</CardTitle>
          <Badge variant="outline" className="text-[10px]">{sorted.length} properties</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50/80">
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Property</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Total Revenue</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Base Rent</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">CAM</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Other</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">% of Total</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">YoY</TableHead>
              <TableHead className="w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((p) => {
              const pct = grandTotal > 0 ? (p.totalRevenue / grandTotal) * 100 : 0;
              return (
                <TableRow
                  key={p.id}
                  className="cursor-pointer hover:bg-blue-50/50 transition-colors group"
                  onClick={() => onSelectProperty(p)}
                >
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors">{p.name}</p>
                      <p className="text-[10px] text-slate-400">{p.city}{p.state ? `, ${p.state}` : ''}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <RevenueSourcePopover sourceType="lease" sourceName={p.name} amount={p.totalRevenue} lastUpdated={p.updated_date}>
                      <span className="text-sm font-semibold">{fmt(p.totalRevenue)}</span>
                    </RevenueSourcePopover>
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono text-slate-700">{fmt(p.baseRent)}</TableCell>
                  <TableCell className="text-right text-sm font-mono text-slate-700">{fmt(p.camRevenue)}</TableCell>
                  <TableCell className="text-right text-sm font-mono text-slate-500">{fmt(p.otherIncome)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className="text-[11px] font-mono text-slate-500 w-10 text-right">{pct.toFixed(1)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {p.yoyChange !== null ? (
                      <div className={`inline-flex items-center gap-0.5 text-xs font-semibold ${p.yoyChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {p.yoyChange >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {p.yoyChange >= 0 ? '+' : ''}{p.yoyChange.toFixed(1)}%
                      </div>
                    ) : (
                      <span className="text-xs text-slate-300"><Minus className="w-3 h-3 inline" /></span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-600 transition-colors" />
                  </TableCell>
                </TableRow>
              );
            })}
            {/* Total row */}
            <TableRow className="bg-slate-50 border-t-2 border-slate-200">
              <TableCell className="font-bold text-sm text-slate-900">Portfolio Total</TableCell>
              <TableCell className="text-right font-bold text-sm font-mono">{fmt(grandTotal)}</TableCell>
              <TableCell className="text-right font-semibold text-sm font-mono text-slate-700">{fmt(sorted.reduce((s, p) => s + p.baseRent, 0))}</TableCell>
              <TableCell className="text-right font-semibold text-sm font-mono text-slate-700">{fmt(sorted.reduce((s, p) => s + p.camRevenue, 0))}</TableCell>
              <TableCell className="text-right font-semibold text-sm font-mono text-slate-500">{fmt(sorted.reduce((s, p) => s + p.otherIncome, 0))}</TableCell>
              <TableCell className="text-right text-xs font-mono text-slate-500">100%</TableCell>
              <TableCell></TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}