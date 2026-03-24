import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Minus, AlertTriangle, ChevronDown, ChevronUp, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from "recharts";

function analyzeIncreaseReasons(currCAMs, prevCAMs, expenses) {
  const reasons = [];
  const currPool = currCAMs.reduce((s, c) => s + (c.total_cam_pool || 0), 0);
  const prevPool = prevCAMs.reduce((s, c) => s + (c.total_cam_pool || 0), 0);

  if (prevPool > 0 && currPool > prevPool) {
    const poolDelta = currPool - prevPool;
    const poolPct = ((poolDelta / prevPool) * 100).toFixed(1);
    reasons.push({ label: "Total CAM Pool Increase", detail: `+$${poolDelta.toLocaleString()} (+${poolPct}%)`, severity: poolPct > 10 ? "high" : poolPct > 5 ? "medium" : "low" });
  }

  // Admin fee changes
  const currAdminFees = currCAMs.reduce((s, c) => s + (c.admin_fee || 0), 0);
  const prevAdminFees = prevCAMs.reduce((s, c) => s + (c.admin_fee || 0), 0);
  if (prevAdminFees > 0 && currAdminFees > prevAdminFees * 1.05) {
    reasons.push({ label: "Admin Fee Increase", detail: `$${prevAdminFees.toLocaleString()} → $${currAdminFees.toLocaleString()}`, severity: "medium" });
  }

  // Gross-up changes
  const currGrossUp = currCAMs.reduce((s, c) => s + (c.gross_up_adjustment || 0), 0);
  const prevGrossUp = prevCAMs.reduce((s, c) => s + (c.gross_up_adjustment || 0), 0);
  if (currGrossUp > prevGrossUp && prevGrossUp >= 0) {
    reasons.push({ label: "Gross-Up Adjustment", detail: `+$${(currGrossUp - prevGrossUp).toLocaleString()} (vacancy adjustment)`, severity: "medium" });
  }

  // Controllable vs non-controllable
  const currCtrl = currCAMs.reduce((s, c) => s + (c.controllable_total || 0), 0);
  const prevCtrl = prevCAMs.reduce((s, c) => s + (c.controllable_total || 0), 0);
  const currNonCtrl = currCAMs.reduce((s, c) => s + (c.non_controllable_total || 0), 0);
  const prevNonCtrl = prevCAMs.reduce((s, c) => s + (c.non_controllable_total || 0), 0);

  if (prevCtrl > 0 && currCtrl > prevCtrl * 1.05) {
    reasons.push({ label: "Controllable Expenses Up", detail: `+$${(currCtrl - prevCtrl).toLocaleString()} (+${((currCtrl - prevCtrl) / prevCtrl * 100).toFixed(0)}%)`, severity: "medium" });
  }
  if (prevNonCtrl > 0 && currNonCtrl > prevNonCtrl * 1.05) {
    reasons.push({ label: "Non-Controllable Expenses Up", detail: `+$${(currNonCtrl - prevNonCtrl).toLocaleString()} (taxes/insurance/utilities)`, severity: "high" });
  }

  // Expense category analysis
  const currentYear = new Date().getFullYear();
  const currYearExp = expenses.filter(e => e.fiscal_year === currentYear && e.classification === 'recoverable');
  const prevYearExp = expenses.filter(e => e.fiscal_year === currentYear - 1 && e.classification === 'recoverable');
  const currCats = {};
  const prevCats = {};
  currYearExp.forEach(e => { currCats[e.category] = (currCats[e.category] || 0) + (e.amount || 0); });
  prevYearExp.forEach(e => { prevCats[e.category] = (prevCats[e.category] || 0) + (e.amount || 0); });

  Object.keys(currCats).forEach(cat => {
    const curr = currCats[cat];
    const prev = prevCats[cat] || 0;
    if (prev > 0 && curr > prev * 1.15) {
      reasons.push({ label: `${cat.replace(/_/g, ' ')} Expense Spike`, detail: `$${prev.toLocaleString()} → $${curr.toLocaleString()} (+${((curr - prev) / prev * 100).toFixed(0)}%)`, severity: "medium" });
    } else if (curr > 0 && prev === 0) {
      reasons.push({ label: `New: ${cat.replace(/_/g, ' ')}`, detail: `$${curr.toLocaleString()} (new category)`, severity: "low" });
    }
  });

  return reasons;
}

export default function CAMReviewTab({ camCalcs, expenses, leases, currentYear, prevYear, scopeProperty }) {
  const [expandedTenant, setExpandedTenant] = useState(null);

  const scopedCAMs = scopeProperty !== "all" ? camCalcs.filter(c => c.property_id === scopeProperty) : camCalcs;
  const currCAMs = scopedCAMs.filter(c => c.fiscal_year === currentYear);
  const prevCAMs = scopedCAMs.filter(c => c.fiscal_year === prevYear);
  const scopedExpenses = scopeProperty !== "all" ? expenses.filter(e => e.property_id === scopeProperty) : expenses;

  const currTotal = currCAMs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const prevTotal = prevCAMs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const totalDelta = currTotal - prevTotal;
  const totalPct = prevTotal > 0 ? (totalDelta / prevTotal * 100).toFixed(1) : null;

  const currPool = currCAMs.reduce((s, c) => s + (c.total_cam_pool || 0), 0);
  const prevPool = prevCAMs.reduce((s, c) => s + (c.total_cam_pool || 0), 0);
  const currAdminFees = currCAMs.reduce((s, c) => s + (c.admin_fee || 0), 0);
  const currGrossUp = currCAMs.reduce((s, c) => s + (c.gross_up_adjustment || 0), 0);

  // Increase reasons
  const reasons = analyzeIncreaseReasons(currCAMs, prevCAMs, scopedExpenses);
  const sevColors = { high: "bg-red-100 text-red-700 border-red-200", medium: "bg-amber-100 text-amber-700 border-amber-200", low: "bg-blue-100 text-blue-700 border-blue-200" };

  // Tenant-level comparison
  const tenantData = currCAMs.map(curr => {
    const prev = prevCAMs.find(p => p.lease_id === curr.lease_id || p.tenant_name === curr.tenant_name);
    const prevAnnual = prev?.annual_cam || 0;
    const delta = (curr.annual_cam || 0) - prevAnnual;
    const pct = prevAnnual > 0 ? (delta / prevAnnual * 100) : null;
    const lease = leases.find(l => l.id === curr.lease_id);
    return {
      ...curr, prevAnnual, delta, pct, capApplied: curr.cap_applied,
      leaseType: lease?.lease_type, totalSF: lease?.total_sf || curr.tenant_share_pct
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Chart data - top tenants
  const chartData = tenantData.slice(0, 8).map(t => ({
    name: (t.tenant_name || "Unknown").substring(0, 14),
    [prevYear]: t.prevAnnual,
    [currentYear]: t.annual_cam || 0,
  }));

  // Pool composition pie
  const poolPie = [
    { name: "CAM Pool", value: currPool, color: "#0d9488" },
    { name: "Admin Fees", value: currAdminFees, color: "#6366f1" },
    { name: "Gross-Up", value: currGrossUp, color: "#f59e0b" },
  ].filter(d => d.value > 0);

  const capsApplied = tenantData.filter(t => t.capApplied).length;

  return (
    <div className="space-y-5">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="border-l-4 border-l-teal-500">
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Total CAM ({currentYear})</p>
            <p className="text-xl font-bold">${currTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Prior Year ({prevYear})</p>
            <p className="text-xl font-bold text-slate-500">${prevTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className={totalDelta > 0 ? "border-l-4 border-l-red-400" : "border-l-4 border-l-emerald-400"}>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">YoY Change</p>
            <p className={`text-xl font-bold ${totalDelta > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {totalDelta > 0 ? '+' : ''}{totalPct !== null ? `${totalPct}%` : '—'}
            </p>
            <p className="text-[10px] text-slate-400">{totalDelta > 0 ? '+' : ''}${totalDelta.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Tenants Calculated</p>
            <p className="text-xl font-bold">{currCAMs.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Caps Applied</p>
            <p className="text-xl font-bold text-amber-600">{capsApplied}</p>
            <p className="text-[10px] text-slate-400">of {currCAMs.length} tenants</p>
          </CardContent>
        </Card>
      </div>

      {/* Increase Reasons */}
      {reasons.length > 0 && (
        <Card className="border-amber-200 bg-gradient-to-r from-amber-50/50 to-orange-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              CAM Increase Drivers ({currentYear} vs {prevYear})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {reasons.map((r, i) => (
                <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${sevColors[r.severity]}`}>
                  <span className="text-xs font-medium">{r.label}</span>
                  <span className="text-xs font-mono font-semibold">{r.detail}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-4">
        {chartData.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Tenant CAM: {prevYear} vs {currentYear}</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData}>
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
                  <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey={prevYear} fill="#94a3b8" radius={[4, 4, 0, 0]} barSize={16} />
                  <Bar dataKey={currentYear} fill="#0d9488" radius={[4, 4, 0, 0]} barSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
        {poolPie.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">CAM Pool Composition ({currentYear})</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={poolPie} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value">
                    {poolPie.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-4 mt-1">
                {poolPie.map(d => (
                  <div key={d.name} className="flex items-center gap-1.5 text-[10px]">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="text-slate-600">{d.name}: ${(d.value / 1000).toFixed(1)}K</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Tenant-level Review Table */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Tenant-Level CAM Review</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[10px] font-bold">TENANT</TableHead>
                <TableHead className="text-[10px] font-bold">SHARE %</TableHead>
                <TableHead className="text-[10px] font-bold text-right">FY {prevYear}</TableHead>
                <TableHead className="text-[10px] font-bold text-right">FY {currentYear}</TableHead>
                <TableHead className="text-[10px] font-bold text-right">MONTHLY</TableHead>
                <TableHead className="text-[10px] font-bold text-right">CHANGE</TableHead>
                <TableHead className="text-[10px] font-bold">FLAGS</TableHead>
                <TableHead className="text-[10px] font-bold w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenantData.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-sm text-slate-400">No CAM calculations found for the selected scope/year</TableCell></TableRow>
              ) : tenantData.map(t => (
                <React.Fragment key={t.id}>
                  <TableRow className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpandedTenant(expandedTenant === t.id ? null : t.id)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-[10px]">{t.tenant_name?.charAt(0)}</div>
                        <div>
                          <p className="text-xs font-semibold">{t.tenant_name}</p>
                          {t.leaseType && <p className="text-[9px] text-slate-400 uppercase">{t.leaseType}</p>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{t.tenant_share_pct ? `${t.tenant_share_pct.toFixed(1)}%` : '—'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-slate-500">${t.prevAnnual.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums font-semibold">${(t.annual_cam || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">${(t.monthly_cam || 0).toLocaleString()}/mo</TableCell>
                    <TableCell className="text-right">
                      {t.pct !== null ? (
                        <span className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${t.delta > 0 ? 'text-red-600' : t.delta < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {t.delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : t.delta < 0 ? <ArrowDownRight className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                          {t.delta > 0 ? '+' : ''}{t.pct.toFixed(1)}%
                        </span>
                      ) : <span className="text-xs text-slate-300">New</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {t.capApplied && <Badge className="bg-amber-100 text-amber-700 text-[8px]">CAPPED</Badge>}
                        {t.gross_up_applied && <Badge className="bg-purple-100 text-purple-700 text-[8px]">GROSS-UP</Badge>}
                        {t.pct > 15 && <Badge className="bg-red-100 text-red-700 text-[8px]">SPIKE</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>{expandedTenant === t.id ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}</TableCell>
                  </TableRow>
                  {expandedTenant === t.id && (
                    <TableRow>
                      <TableCell colSpan={8} className="bg-slate-50/80 p-4">
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                          <div className="bg-white rounded-lg p-2.5 border"><p className="text-[9px] text-slate-400 uppercase">CAM Pool</p><p className="text-sm font-bold">${(t.total_cam_pool || 0).toLocaleString()}</p></div>
                          <div className="bg-white rounded-lg p-2.5 border"><p className="text-[9px] text-slate-400 uppercase">Admin Fee</p><p className="text-sm font-bold">${(t.admin_fee || 0).toLocaleString()}</p></div>
                          <div className="bg-white rounded-lg p-2.5 border"><p className="text-[9px] text-slate-400 uppercase">Gross-Up Adj.</p><p className="text-sm font-bold">${(t.gross_up_adjustment || 0).toLocaleString()}</p></div>
                          <div className="bg-white rounded-lg p-2.5 border"><p className="text-[9px] text-slate-400 uppercase">Base Year Deduction</p><p className="text-sm font-bold">${(t.base_year_deduction || 0).toLocaleString()}</p></div>
                        </div>
                        {t.capApplied && t.cap_amount && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-xs">
                            <span className="font-semibold text-amber-800">Cap Applied:</span> Annual CAM capped at ${t.cap_amount.toLocaleString()} — saved tenant ${((t.annual_cam || 0) > 0 ? Math.max(0, (t.total_cam_pool || 0) * (t.tenant_share_pct || 0) / 100 - t.cap_amount) : 0).toLocaleString()}
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                          <span>Allocation: <strong className="text-slate-700">{t.allocation_model || 'pro_rata'}</strong></span>
                          <span>Proration: <strong className="text-slate-700">{t.proration_months || 12} months</strong></span>
                          <span>Vacancy: <strong className="text-slate-700">{t.vacancy_handling || 'include'}</strong></span>
                        </div>
                        {t.breakdown?.length > 0 && (
                          <div className="mt-3">
                            <p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Expense Breakdown</p>
                            <div className="grid gap-1 max-h-32 overflow-y-auto">
                              {t.breakdown.map((b, i) => (
                                <div key={i} className="flex justify-between text-xs bg-white rounded px-3 py-1.5 border border-slate-100">
                                  <span className="capitalize text-slate-600">{(b.category || b.name || '').replace(/_/g, ' ')}</span>
                                  <span className="font-mono font-semibold">${(b.amount || b.value || 0).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
              {/* Totals row */}
              {tenantData.length > 0 && (
                <TableRow className="bg-slate-100 font-bold">
                  <TableCell className="text-xs">TOTAL ({tenantData.length} tenants)</TableCell>
                  <TableCell></TableCell>
                  <TableCell className="text-right text-xs tabular-nums">${prevTotal.toLocaleString()}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">${currTotal.toLocaleString()}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">${Math.round(currTotal / 12).toLocaleString()}/mo</TableCell>
                  <TableCell className="text-right">
                    {totalPct !== null && (
                      <span className={`text-xs font-bold ${totalDelta > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {totalDelta > 0 ? '+' : ''}{totalPct}%
                      </span>
                    )}
                  </TableCell>
                  <TableCell colSpan={2}></TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}