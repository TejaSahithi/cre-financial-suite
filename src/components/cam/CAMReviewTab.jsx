import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Minus, AlertTriangle, ChevronDown, ChevronUp, ArrowUpRight, ArrowDownRight, FileSearch } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from "recharts";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import ClauseEvidenceDrawer from "@/components/ExpenseClassification/ClauseEvidenceDrawer";

// Derive CAM increase drivers from snapshot outputs (no client-side calculation).
function analyzeIncreaseReasons(currOutputs, prevOutputs) {
  const reasons = [];

  const currPool = currOutputs?.total_shared_before_fees ?? 0;
  const prevPool = prevOutputs?.total_shared_before_fees ?? 0;
  if (prevPool > 0 && currPool > prevPool) {
    const poolDelta = currPool - prevPool;
    const poolPct = ((poolDelta / prevPool) * 100).toFixed(1);
    reasons.push({
      label: "Total CAM Pool Increase",
      detail: `+$${poolDelta.toLocaleString()} (+${poolPct}%)`,
      severity: poolPct > 10 ? "high" : poolPct > 5 ? "medium" : "low",
    });
  }

  const currAdminFees = currOutputs?.admin_fees ?? 0;
  const prevAdminFees = prevOutputs?.admin_fees ?? 0;
  if (prevAdminFees > 0 && currAdminFees > prevAdminFees * 1.05) {
    reasons.push({
      label: "Admin Fee Increase",
      detail: `$${prevAdminFees.toLocaleString()} → $${currAdminFees.toLocaleString()}`,
      severity: "medium",
    });
  }

  const currGrossUp = currOutputs?.gross_up_adjustment ?? 0;
  const prevGrossUp = prevOutputs?.gross_up_adjustment ?? 0;
  if (currGrossUp > prevGrossUp && prevGrossUp >= 0 && currGrossUp > 0) {
    reasons.push({
      label: "Gross-Up Adjustment",
      detail: `+$${(currGrossUp - prevGrossUp).toLocaleString()} (vacancy adjustment)`,
      severity: "medium",
    });
  }

  // Per-category totals aggregated from all tenant breakdown rows in each snapshot.
  const currCats = {};
  const prevCats = {};
  (currOutputs?.tenant_charges ?? []).forEach((t) => {
    (t.breakdown ?? []).forEach((b) => {
      if (b.category) currCats[b.category] = (currCats[b.category] || 0) + (b.amount || 0);
    });
  });
  (prevOutputs?.tenant_charges ?? []).forEach((t) => {
    (t.breakdown ?? []).forEach((b) => {
      if (b.category) prevCats[b.category] = (prevCats[b.category] || 0) + (b.amount || 0);
    });
  });
  Object.keys(currCats).forEach((cat) => {
    const curr = currCats[cat];
    const prev = prevCats[cat] || 0;
    if (prev > 0 && curr > prev * 1.15) {
      reasons.push({
        label: `${cat.replace(/_/g, " ")} Expense Spike`,
        detail: `$${prev.toLocaleString()} → $${curr.toLocaleString()} (+${((curr - prev) / prev * 100).toFixed(0)}%)`,
        severity: "medium",
      });
    } else if (curr > 0 && prev === 0) {
      reasons.push({
        label: `New: ${cat.replace(/_/g, " ")}`,
        detail: `$${curr.toLocaleString()} (new category)`,
        severity: "low",
      });
    }
  });

  return reasons;
}

// Resolve evidence for a single breakdown row, with the matching priority
// defined in the spec: lease_id+category → lease_id only → tenant_name fallback.
function resolveEvidence(ruleEvidence, leaseId, tenantName, catKey) {
  if (leaseId) {
    // Primary: exact lease + category match
    const primary = ruleEvidence.find(
      (e) => e.lease_id === leaseId && (e.category || "").toLowerCase() === catKey,
    );
    if (primary) return { ev: primary, fallback: false };

    // Fallback A: any evidence for this lease (broad)
    const broad = ruleEvidence.find((e) => e.lease_id === leaseId);
    if (broad) return { ev: broad, fallback: true };
  }

  // Fallback B: tenant_name match when lease_id is absent (last resort)
  if (!leaseId && tenantName) {
    // rule_evidence carries lease_id not tenant_name, so this will rarely fire.
    // Kept as a safety net for edge cases where snapshot tenant_charges has no lease_id.
    const byName = ruleEvidence.find(
      (e) => !e.lease_id && (e.category || "").toLowerCase() === catKey,
    );
    if (byName) return { ev: byName, fallback: true };
  }

  return { ev: null, fallback: false };
}

export default function CAMReviewTab({ camCalcs, expenses, leases, currentYear, prevYear, scopeProperty }) {
  // camCalcs and expenses are passed by the parent but no longer used for tenant data.
  // Tenant-level data now comes from computation_snapshots.outputs.tenant_charges[].
  const [expandedTenant, setExpandedTenant] = useState(null);
  const [evidenceTarget, setEvidenceTarget] = useState(null);

  const propId = scopeProperty !== "all" ? scopeProperty : null;

  const { snapshot, isLoading } = useSnapshotQuery({
    engineType: "cam",
    propertyId: propId,
    fiscalYear: currentYear,
  });

  const { snapshot: prevSnapshot } = useSnapshotQuery({
    engineType: "cam",
    propertyId: propId,
    fiscalYear: prevYear ?? currentYear - 1,
  });

  const currOutputs = snapshot?.outputs ?? null;
  const prevOutputs = prevSnapshot?.outputs ?? null;
  const tenantCharges = currOutputs?.tenant_charges ?? [];
  const prevTenantCharges = prevOutputs?.tenant_charges ?? [];
  const ruleEvidence = snapshot?.inputs?.rule_evidence ?? [];

  // Aggregates read directly from snapshot outputs — no client-side math.
  const currTotal = Math.round(currOutputs?.total_cam ?? 0);
  const prevTotal = Math.round(
    prevOutputs?.total_cam ?? currOutputs?.prev_year_total ?? 0,
  );
  const totalDelta = currTotal - prevTotal;
  const totalPct = prevTotal > 0 ? (totalDelta / prevTotal * 100).toFixed(1) : null;

  const currPool = currOutputs?.total_shared_before_fees ?? 0;
  const currAdminFees = currOutputs?.admin_fees ?? 0;
  const currGrossUp = currOutputs?.gross_up_adjustment ?? 0;

  const reasons = analyzeIncreaseReasons(currOutputs, prevOutputs);
  const sevColors = {
    high: "bg-red-100 text-red-700 border-red-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low: "bg-blue-100 text-blue-700 border-blue-200",
  };

  // Build enriched tenant rows for the table. Prev-year match is by lease_id.
  const tenantData = tenantCharges.map((t) => {
    const prev = prevTenantCharges.find((p) => p.lease_id === t.lease_id);
    const prevAnnual = prev?.annual_cam ?? 0;
    const delta = (t.annual_cam ?? 0) - prevAnnual;
    const pct = prevAnnual > 0 ? (delta / prevAnnual * 100) : null;
    const lease = leases?.find((l) => l.id === t.lease_id);
    return { ...t, prevAnnual, delta, pct, leaseType: lease?.lease_type };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const capsApplied = tenantData.filter((t) => t.cap_applied).length;

  const chartData = tenantData.slice(0, 8).map((t) => ({
    name: (t.tenant_name || "Unknown").substring(0, 14),
    [prevYear]: t.prevAnnual,
    [currentYear]: t.annual_cam || 0,
  }));

  const poolPie = [
    { name: "CAM Pool", value: currPool, color: "#0d9488" },
    { name: "Admin Fees", value: currAdminFees, color: "#6366f1" },
    { name: "Gross-Up", value: currGrossUp, color: "#f59e0b" },
  ].filter((d) => d.value > 0);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">Loading CAM snapshot…</div>
    );
  }

  if (!snapshot) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-slate-500">No authoritative CAM snapshot found for FY {currentYear}.</p>
          <p className="text-xs text-slate-400 mt-1">Run a CAM calculation first to populate tenant-level data.</p>
        </CardContent>
      </Card>
    );
  }

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
            <p className={`text-xl font-bold ${totalDelta > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {totalDelta > 0 ? "+" : ""}{totalPct !== null ? `${totalPct}%` : "—"}
            </p>
            <p className="text-[10px] text-slate-400">{totalDelta > 0 ? "+" : ""}${totalDelta.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Tenants Calculated</p>
            <p className="text-xl font-bold">{tenantCharges.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-slate-500 uppercase font-bold">Caps Applied</p>
            <p className="text-xl font-bold text-amber-600">{capsApplied}</p>
            <p className="text-[10px] text-slate-400">of {tenantCharges.length} tenants</p>
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
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                  <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
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
                  <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-4 mt-1">
                {poolPie.map((d) => (
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
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Tenant-Level CAM Review</CardTitle>
        </CardHeader>
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
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-sm text-slate-400">
                    No tenant charges in snapshot for the selected scope / year
                  </TableCell>
                </TableRow>
              ) : tenantData.map((t, idx) => {
                const rowId = t.lease_id || `row-${idx}`;
                return (
                  <React.Fragment key={rowId}>
                    <TableRow
                      className="hover:bg-slate-50 cursor-pointer"
                      onClick={() => setExpandedTenant(expandedTenant === rowId ? null : rowId)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-[10px]">
                            {t.tenant_name?.charAt(0)}
                          </div>
                          <div>
                            <p className="text-xs font-semibold">{t.tenant_name || "—"}</p>
                            {t.leaseType && <p className="text-[9px] text-slate-400 uppercase">{t.leaseType}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {t.tenant_share_pct ? `${t.tenant_share_pct.toFixed(1)}%` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-slate-500">
                        ${t.prevAnnual.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums font-semibold">
                        ${(t.annual_cam || 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${(t.monthly_cam || 0).toLocaleString()}/mo
                      </TableCell>
                      <TableCell className="text-right">
                        {t.pct !== null ? (
                          <span className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${t.delta > 0 ? "text-red-600" : t.delta < 0 ? "text-emerald-600" : "text-slate-400"}`}>
                            {t.delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : t.delta < 0 ? <ArrowDownRight className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                            {t.delta > 0 ? "+" : ""}{t.pct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-xs text-slate-300">New</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {t.cap_applied && <Badge className="bg-amber-100 text-amber-700 text-[8px]">CAPPED</Badge>}
                          {t.gross_up_applied && <Badge className="bg-blue-100 text-blue-700 text-[8px]">GROSS-UP</Badge>}
                          {t.pct > 15 && <Badge className="bg-red-100 text-red-700 text-[8px]">SPIKE</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {expandedTenant === rowId
                          ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                          : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                      </TableCell>
                    </TableRow>

                    {expandedTenant === rowId && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-slate-50/80 p-4">
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                            <div className="bg-white rounded-lg p-2.5 border">
                              <p className="text-[9px] text-slate-400 uppercase">CAM Pool</p>
                              <p className="text-sm font-bold">${(t.total_cam_pool || 0).toLocaleString()}</p>
                            </div>
                            <div className="bg-white rounded-lg p-2.5 border">
                              <p className="text-[9px] text-slate-400 uppercase">Admin Fee</p>
                              <p className="text-sm font-bold">${(t.admin_fee || 0).toLocaleString()}</p>
                            </div>
                            <div className="bg-white rounded-lg p-2.5 border">
                              <p className="text-[9px] text-slate-400 uppercase">Gross-Up Adj.</p>
                              <p className="text-sm font-bold">${(t.gross_up_adjustment || 0).toLocaleString()}</p>
                            </div>
                            <div className="bg-white rounded-lg p-2.5 border">
                              <p className="text-[9px] text-slate-400 uppercase">Base Year Deduction</p>
                              <p className="text-sm font-bold">${(t.base_year_deduction || 0).toLocaleString()}</p>
                            </div>
                          </div>

                          {t.cap_applied && t.cap_amount && (
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-xs">
                              <span className="font-semibold text-amber-800">Cap Applied:</span>{" "}
                              Annual CAM capped at ${t.cap_amount.toLocaleString()}
                            </div>
                          )}

                          <div className="flex items-center gap-4 text-xs text-slate-500 mb-3">
                            <span>Allocation: <strong className="text-slate-700">{t.allocation_model || "pro_rata"}</strong></span>
                            <span>Proration: <strong className="text-slate-700">{t.proration_months || 12} months</strong></span>
                            <span>Vacancy: <strong className="text-slate-700">{t.vacancy_handling || "include"}</strong></span>
                          </div>

                          {/* Expense Breakdown with Evidence */}
                          {t.breakdown && t.breakdown.length > 0 ? (
                            <div>
                              <p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Expense Breakdown</p>
                              <div className="grid gap-1 max-h-48 overflow-y-auto">
                                {t.breakdown.map((b, bi) => {
                                  const catKey = (b.category || "").toLowerCase();
                                  const { ev, fallback } = resolveEvidence(ruleEvidence, t.lease_id, t.tenant_name, catKey);
                                  return (
                                    <div key={bi} className="flex items-center justify-between text-xs bg-white rounded px-3 py-1.5 border border-slate-100">
                                      <div className="flex items-center gap-1.5">
                                        <span className="capitalize text-slate-600">{catKey.replace(/_/g, " ") || "—"}</span>
                                        {b.share_pct != null && (
                                          <span className="text-[9px] text-slate-400">({b.share_pct.toFixed(1)}%)</span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="font-mono font-semibold">${(b.amount || 0).toLocaleString()}</span>
                                        {ev ? (
                                          <button
                                            className={`flex items-center gap-0.5 text-[9px] ${fallback ? "text-slate-400 hover:text-slate-600" : "text-blue-500 hover:text-blue-700"}`}
                                            title={fallback ? "Broad lease evidence (category not matched)" : "View extraction evidence"}
                                            onClick={(e) => { e.stopPropagation(); setEvidenceTarget({ ev, catKey }); }}
                                          >
                                            <FileSearch className="w-3 h-3" />
                                            {fallback && <span>Lease</span>}
                                          </button>
                                        ) : (
                                          <span className="text-[9px] text-slate-300">No linked evidence yet</span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <p className="text-xs text-slate-400 italic">No breakdown available in snapshot.</p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}

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
                      <span className={`text-xs font-bold ${totalDelta > 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {totalDelta > 0 ? "+" : ""}{totalPct}%
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

      <ClauseEvidenceDrawer
        isOpen={!!evidenceTarget}
        onClose={() => setEvidenceTarget(null)}
        category={{ category_name: (evidenceTarget?.catKey || "").replace(/_/g, " ") }}
        rule={evidenceTarget ? {
          exact_source_text: evidenceTarget.ev.source_text,
          source_page: evidenceTarget.ev.source_page,
          confidence_score: evidenceTarget.ev.confidence_score,
          approved_by: evidenceTarget.ev.approved_by,
          approved_at: evidenceTarget.ev.approved_at,
          notes: evidenceTarget.ev.field_review_text ?? null,
          review_status: "approved",
          approval_status: "approved",
          published_to_cam: true,
        } : null}
      />
    </div>
  );
}
