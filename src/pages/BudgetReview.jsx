import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Loader2, ArrowUpRight, ArrowDownRight, Minus, AlertTriangle, Info, Download, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from "recharts";

import useOrgQuery from "@/hooks/useOrgQuery";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import ScopeSelector from "@/components/ScopeSelector";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createPageUrl } from "@/utils";

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function n(v) { return Number(v) || 0; }
function fmt(v) { return CURRENCY.format(n(v)); }
function fmtC(v) { return COMPACT.format(n(v)); }
function pct(curr, prev) { return prev !== 0 ? (curr - prev) / Math.abs(prev) : null; }
function fmtPct(v) { return v !== null && Number.isFinite(v) ? PCT.format(v) : "—"; }

function DeltaBadge({ delta, pctVal }) {
  if (delta === 0 && (pctVal === null || pctVal === 0)) {
    return <span className="inline-flex items-center gap-0.5 text-xs text-slate-400"><Minus className="w-3 h-3" /> No change</span>;
  }
  const up = delta > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${up ? "text-red-600" : "text-emerald-600"}`}>
      {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {up ? "+" : ""}{fmt(delta)} ({fmtPct(pctVal)})
    </span>
  );
}

function analyzeDrivers(currBudget, prevBudget, currExpenses, prevExpenses) {
  const drivers = [];
  const cr = n(currBudget?.total_revenue);
  const pr = n(prevBudget?.total_revenue);
  const ce = n(currBudget?.total_expenses);
  const pe = n(prevBudget?.total_expenses);
  const cc = n(currBudget?.cam_total);
  const pc = n(prevBudget?.cam_total);
  const cn = n(currBudget?.noi);
  const pn = n(prevBudget?.noi);

  if (pr > 0 && cr !== pr) {
    const d = cr - pr;
    const p = ((d / pr) * 100).toFixed(1);
    drivers.push({
      label: `Revenue ${d > 0 ? "Increase" : "Decrease"}`,
      detail: `${fmt(pr)} -> ${fmt(cr)} (${d > 0 ? "+" : ""}${p}%)`,
      severity: Math.abs(d / pr) > 0.1 ? "high" : Math.abs(d / pr) > 0.05 ? "medium" : "low",
      reason: d > 0 ? "Higher rental income or additional tenants" : "Vacancy increase or rent concessions",
    });
  }

  if (pe > 0 && ce !== pe) {
    const d = ce - pe;
    const p = ((d / pe) * 100).toFixed(1);
    drivers.push({
      label: `Operating Expenses ${d > 0 ? "Increase" : "Decrease"}`,
      detail: `${fmt(pe)} -> ${fmt(ce)} (${d > 0 ? "+" : ""}${p}%)`,
      severity: d > 0 && Math.abs(d / pe) > 0.1 ? "high" : Math.abs(d / pe) > 0.05 ? "medium" : "low",
      reason: d > 0 ? "Rising vendor costs, inflation, or new service contracts" : "Cost optimization or renegotiated contracts",
    });
  }

  if (pc > 0 && cc !== pc) {
    const d = cc - pc;
    const p = ((d / pc) * 100).toFixed(1);
    drivers.push({
      label: `CAM Recovery ${d > 0 ? "Increase" : "Decrease"}`,
      detail: `${fmt(pc)} -> ${fmt(cc)} (${d > 0 ? "+" : ""}${p}%)`,
      severity: Math.abs(d / pc) > 0.1 ? "high" : "medium",
      reason: d > 0 ? "Higher recoverable expenses or updated pro-rata shares" : "Lower recoverable pool or cap adjustments",
    });
  }

  if (pn !== 0 && cn !== pn) {
    const d = cn - pn;
    const noiSev = d < 0 && Math.abs(d / Math.abs(pn)) > 0.1 ? "high" : Math.abs(d / Math.abs(pn)) > 0.05 ? "medium" : "low";
    drivers.push({
      label: `NOI ${d > 0 ? "Improvement" : "Decline"}`,
      detail: `${fmt(pn)} -> ${fmt(cn)}`,
      severity: noiSev,
      reason: d > 0 ? "Revenue growth outpacing expense growth" : "Expenses growing faster than revenue",
    });
  }

  // Category-level expense analysis
  const currCats = {};
  const prevCats = {};
  currExpenses.forEach(e => { currCats[e.category || "other"] = (currCats[e.category || "other"] || 0) + n(e.amount); });
  prevExpenses.forEach(e => { prevCats[e.category || "other"] = (prevCats[e.category || "other"] || 0) + n(e.amount); });

  for (const cat of Object.keys(currCats)) {
    const curr = currCats[cat];
    const prev = prevCats[cat] || 0;
    if (prev > 0 && curr > prev * 1.15) {
      const d = curr - prev;
      drivers.push({
        label: `${cat.replace(/_/g, " ")} Expense Spike`,
        detail: `${fmt(prev)} -> ${fmt(curr)} (+${((d / prev) * 100).toFixed(0)}%)`,
        severity: d / prev > 0.25 ? "high" : "medium",
        reason: "Category spending significantly above prior year",
      });
    } else if (curr > 0 && prev === 0) {
      drivers.push({
        label: `New Category: ${cat.replace(/_/g, " ")}`,
        detail: `${fmt(curr)} (new)`,
        severity: "low",
        reason: "New expense category not present in prior year",
      });
    }
  }

  return drivers;
}

function buildCategoryComparison(currExpenses, prevExpenses) {
  const cats = new Set();
  const currMap = {};
  const prevMap = {};
  currExpenses.forEach(e => {
    const c = e.category || "other";
    cats.add(c);
    currMap[c] = (currMap[c] || 0) + n(e.amount);
  });
  prevExpenses.forEach(e => {
    const c = e.category || "other";
    cats.add(c);
    prevMap[c] = (prevMap[c] || 0) + n(e.amount);
  });

  return Array.from(cats)
    .map(cat => ({
      category: cat,
      curr: currMap[cat] || 0,
      prev: prevMap[cat] || 0,
      delta: (currMap[cat] || 0) - (prevMap[cat] || 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export default function BudgetReview() {
  const location = useLocation();

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: budgets = [], isLoading } = useOrgQuery("Budget");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: expenses = [] } = useOrgQuery("Expense");

  const scope = useMemo(
    () => buildHierarchyScope({ search: location.search, portfolios, properties, buildings, units }),
    [location.search, portfolios, properties, buildings, units]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const scopedBudgets = budgets.filter(b =>
    matchesHierarchyScope(b, scope, { portfolioKey: "portfolio_id", propertyKey: "property_id", buildingKey: "building_id", unitKey: "unit_id" })
  );

  const filteredBudgets = scopedBudgets.filter(b => {
    if (scopeProperty !== "all" && b.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && b.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && b.unit_id !== scopeUnit) return false;
    return true;
  });

  const availableBudgetYears = useMemo(
    () =>
      [...new Set(
        filteredBudgets
          .map((budget) => Number(budget.budget_year || budget.fiscal_year))
          .filter((year) => Number.isFinite(year) && year > 0)
      )].sort((a, b) => b - a),
    [filteredBudgets]
  );

  const currentYear = availableBudgetYears[0] || new Date().getFullYear();
  const prevYear = availableBudgetYears.find((year) => year < currentYear) || currentYear - 1;

  const currBudgets = filteredBudgets.filter(b => (b.budget_year || b.fiscal_year) === currentYear);
  const prevBudgets = filteredBudgets.filter(b => (b.budget_year || b.fiscal_year) === prevYear);

  // Aggregate across all matching budgets for each year
  const currAgg = {
    total_revenue: currBudgets.reduce((s, b) => s + n(b.total_revenue), 0),
    total_expenses: currBudgets.reduce((s, b) => s + n(b.total_expenses), 0),
    cam_total: currBudgets.reduce((s, b) => s + n(b.cam_total), 0),
    noi: currBudgets.reduce((s, b) => s + n(b.noi), 0),
    count: currBudgets.length,
  };
  const prevAgg = {
    total_revenue: prevBudgets.reduce((s, b) => s + n(b.total_revenue), 0),
    total_expenses: prevBudgets.reduce((s, b) => s + n(b.total_expenses), 0),
    cam_total: prevBudgets.reduce((s, b) => s + n(b.cam_total), 0),
    noi: prevBudgets.reduce((s, b) => s + n(b.noi), 0),
    count: prevBudgets.length,
  };

  // Expense category analysis
  const scopedExpenses = expenses.filter(e => {
    if (scopeProperty !== "all" && e.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && e.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && e.unit_id !== scopeUnit) return false;
    return true;
  });
  const currExpenses = scopedExpenses.filter(e => e.fiscal_year === currentYear);
  const prevExpenses = scopedExpenses.filter(e => e.fiscal_year === prevYear);

  const drivers = analyzeDrivers(currAgg, prevAgg, currExpenses, prevExpenses);
  const categoryRows = buildCategoryComparison(currExpenses, prevExpenses);
  const sevColors = {
    high: "bg-red-50 text-red-700 border-red-200",
    medium: "bg-amber-50 text-amber-700 border-amber-200",
    low: "bg-blue-50 text-blue-700 border-blue-200",
  };

  // Property-level comparison for table
  const propertyComparison = useMemo(() => {
    const propMap = new Map();
    for (const b of filteredBudgets) {
      const pid = b.property_id || "unknown";
      if (!propMap.has(pid)) propMap.set(pid, { curr: null, prev: null });
      const year = b.budget_year || b.fiscal_year;
      if (year === currentYear) propMap.get(pid).curr = b;
      if (year === prevYear) propMap.get(pid).prev = b;
    }
    return Array.from(propMap.entries()).map(([pid, { curr, prev }]) => {
      const prop = properties.find(p => p.id === pid);
      return {
        property_id: pid,
        property_name: prop?.name || pid?.substring(0, 8),
        curr, prev,
        revDelta: n(curr?.total_revenue) - n(prev?.total_revenue),
        expDelta: n(curr?.total_expenses) - n(prev?.total_expenses),
        noiDelta: n(curr?.noi) - n(prev?.noi),
        camDelta: n(curr?.cam_total) - n(prev?.cam_total),
      };
    }).sort((a, b) => Math.abs(b.noiDelta) - Math.abs(a.noiDelta));
  }, [filteredBudgets, currentYear, prevYear, properties]);

  // Charts
  const summaryChartData = [
    { name: "Revenue", [prevYear]: prevAgg.total_revenue, [currentYear]: currAgg.total_revenue, fill: "#0f766e" },
    { name: "Expenses", [prevYear]: prevAgg.total_expenses, [currentYear]: currAgg.total_expenses, fill: "#dc2626" },
    { name: "CAM", [prevYear]: prevAgg.cam_total, [currentYear]: currAgg.cam_total, fill: "#2563eb" },
    { name: "NOI", [prevYear]: prevAgg.noi, [currentYear]: currAgg.noi, fill: "#059669" },
  ];

  const topCatChart = categoryRows.slice(0, 8).map(r => ({
    name: r.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).substring(0, 16),
    [prevYear]: r.prev,
    [currentYear]: r.curr,
  }));

  const expenseComposition = categoryRows.filter(r => r.curr > 0).map((r, i) => ({
    name: r.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    value: r.curr,
    color: ["#0d9488", "#6366f1", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b", "#06b6d4"][i % 10],
  }));

  const handleExport = async (budget) => {
    if (!budget) return;
    const toastId = toast.loading("Preparing budget export...");
    try {
      const data = await invokeEdgeFunction("export-data", {
        export_type: "budget",
        property_id: budget.property_id,
        fiscal_year: budget.budget_year || budget.fiscal_year || currentYear,
        format: "csv",
      });
      if (!data?.download_url) throw new Error("Download URL not received");
      window.open(data.download_url, "_blank", "noopener");
      toast.success("Export ready", { id: toastId });
    } catch (err) {
      toast.error(`Export failed: ${err.message}`, { id: toastId });
    }
  };

  const hasBothYears = currAgg.count > 0 && prevAgg.count > 0;
  const hasAnyBudget = currAgg.count > 0 || prevAgg.count > 0;
  const subtitleScope = getScopeSubtitle(scope, {
    default: `${filteredBudgets.length} budgets across the active scope`,
    portfolio: (portfolio) => `${filteredBudgets.length} budgets in ${portfolio.name}`,
    property: (property) => `${filteredBudgets.length} budgets for ${property.name}`,
    building: (building) => `${filteredBudgets.length} budgets for ${building.name}`,
    unit: (unit) => `${filteredBudgets.length} budgets for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${filteredBudgets.length} budgets in the selected organization`,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Budget Review" subtitle={`${subtitleScope} | Year-over-year analysis: FY ${prevYear} vs FY ${currentYear}`}>
        <div className="flex gap-2">
          {currBudgets[0] && (
            <Button variant="outline" size="sm" onClick={() => handleExport(currBudgets[0])}>
              <Download className="mr-2 h-4 w-4" /> Export Current Year
            </Button>
          )}
          <Link to={createPageUrl("BudgetDashboard") + location.search}>
            <Button size="sm">
              Budget Dashboard <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </PageHeader>

      <ScopeSelector
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : !hasAnyBudget ? (
        <Card>
          <CardContent className="p-12 text-center text-slate-400">
            <p>No budgets found for the selected scope.</p>
            <Link to={createPageUrl("CreateBudget") + location.search}>
              <Button className="mt-4">Create Budget</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Total Revenue", curr: currAgg.total_revenue, prev: prevAgg.total_revenue, color: "border-l-teal-500", textColor: "text-teal-700" },
              { label: "Total Expenses", curr: currAgg.total_expenses, prev: prevAgg.total_expenses, color: "border-l-red-400", textColor: "text-red-600" },
              { label: "CAM Recovery", curr: currAgg.cam_total, prev: prevAgg.cam_total, color: "border-l-blue-500", textColor: "text-blue-600" },
              { label: "NOI", curr: currAgg.noi, prev: prevAgg.noi, color: "border-l-emerald-500", textColor: "text-emerald-600" },
            ].map(m => {
              const delta = m.curr - m.prev;
              const p = pct(m.curr, m.prev);
              return (
                <Card key={m.label} className={`border-l-4 ${m.color}`}>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">{m.label}</p>
                    <p className={`text-xl font-bold mt-1 ${m.textColor}`}>{fmt(m.curr)}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Prior: {fmt(m.prev)}</p>
                    {hasBothYears && (
                      <div className="mt-1.5">
                        <DeltaBadge delta={delta} pctVal={p} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* NOI Margin & Expense Ratio Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {(() => {
              const currExpRatio = currAgg.total_revenue > 0 ? currAgg.total_expenses / currAgg.total_revenue : 0;
              const prevExpRatio = prevAgg.total_revenue > 0 ? prevAgg.total_expenses / prevAgg.total_revenue : 0;
              const currNoiMargin = currAgg.total_revenue > 0 ? currAgg.noi / currAgg.total_revenue : 0;
              const prevNoiMargin = prevAgg.total_revenue > 0 ? prevAgg.noi / prevAgg.total_revenue : 0;
              const currCamShare = currAgg.total_revenue > 0 ? currAgg.cam_total / currAgg.total_revenue : 0;
              const prevCamShare = prevAgg.total_revenue > 0 ? prevAgg.cam_total / prevAgg.total_revenue : 0;
              return [
                { label: "Expense Ratio", curr: currExpRatio, prev: prevExpRatio, bg: "bg-rose-50", tone: "text-rose-700", goodIfLower: true },
                { label: "NOI Margin", curr: currNoiMargin, prev: prevNoiMargin, bg: "bg-emerald-50", tone: "text-emerald-700", goodIfLower: false },
                { label: "CAM Recovery Rate", curr: currCamShare, prev: prevCamShare, bg: "bg-blue-50", tone: "text-blue-700", goodIfLower: false },
              ].map(m => {
                const ratioChange = m.curr - m.prev;
                const improved = m.goodIfLower ? ratioChange < 0 : ratioChange > 0;
                return (
                  <div key={m.label} className={`rounded-2xl border border-slate-200 p-4 ${m.bg}`}>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{m.label}</p>
                    <p className={`mt-2 text-2xl font-bold ${m.tone}`}>{fmtPct(m.curr)}</p>
                    {hasBothYears && (
                      <p className={`mt-1 text-xs ${improved ? "text-emerald-600" : "text-red-500"}`}>
                        {improved ? "Improved" : "Worsened"} from {fmtPct(m.prev)}
                      </p>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          {/* Change Drivers */}
          {drivers.length > 0 && (
            <Card className="border-amber-200 bg-gradient-to-r from-amber-50/50 to-orange-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Budget Change Drivers ({prevYear} vs {currentYear})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {drivers.map((d, i) => (
                    <div key={i} className={`px-3 py-2.5 rounded-lg border ${sevColors[d.severity]}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold">{d.label}</span>
                        <span className="text-xs font-mono font-bold">{d.detail}</span>
                      </div>
                      <p className="text-[10px] mt-0.5 opacity-75">{d.reason}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Charts Row */}
          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Budget Summary: {prevYear} vs {currentYear}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={summaryChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={v => fmtC(v)} />
                    <Tooltip formatter={v => fmt(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey={prevYear} fill="#94a3b8" radius={[4, 4, 0, 0]} barSize={20} name={`FY ${prevYear}`} />
                    <Bar dataKey={currentYear} fill="#0d9488" radius={[4, 4, 0, 0]} barSize={20} name={`FY ${currentYear}`} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {topCatChart.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Expense by Category: {prevYear} vs {currentYear}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={topCatChart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#64748b" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={v => fmtC(v)} />
                      <Tooltip formatter={v => fmt(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey={prevYear} fill="#94a3b8" radius={[4, 4, 0, 0]} barSize={14} name={`FY ${prevYear}`} />
                      <Bar dataKey={currentYear} fill="#6366f1" radius={[4, 4, 0, 0]} barSize={14} name={`FY ${currentYear}`} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Expense Composition Pie */}
          {expenseComposition.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">FY {currentYear} Expense Composition</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col lg:flex-row items-center gap-6">
                  <div className="w-full max-w-xs">
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={expenseComposition} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={3}>
                          {expenseComposition.map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip formatter={v => fmt(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {expenseComposition.map(d => (
                      <div key={d.name} className="flex items-center gap-1.5 text-[10px] bg-slate-50 rounded px-2 py-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="text-slate-600">{d.name}: {fmtC(d.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Category Detail Table */}
          {categoryRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Expense Category Comparison</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="text-[10px] font-bold uppercase">Category</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">FY {prevYear}</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">FY {currentYear}</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">Change ($)</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">Change (%)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categoryRows.map(r => {
                      const p = pct(r.curr, r.prev);
                      const up = r.delta > 0;
                      return (
                        <TableRow key={r.category} className="hover:bg-slate-50">
                          <TableCell className="text-xs font-medium capitalize">{r.category.replace(/_/g, " ")}</TableCell>
                          <TableCell className="text-xs text-right text-slate-500">{fmt(r.prev)}</TableCell>
                          <TableCell className="text-xs text-right font-semibold">{fmt(r.curr)}</TableCell>
                          <TableCell className={`text-xs text-right font-semibold ${up ? "text-red-600" : r.delta < 0 ? "text-emerald-600" : "text-slate-400"}`}>
                            {r.delta !== 0 ? `${up ? "+" : ""}${fmt(r.delta)}` : "—"}
                          </TableCell>
                          <TableCell className={`text-xs text-right ${up ? "text-red-600" : r.delta < 0 ? "text-emerald-600" : "text-slate-400"}`}>
                            {fmtPct(p)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-slate-50 font-bold">
                      <TableCell className="text-xs font-bold">Total</TableCell>
                      <TableCell className="text-xs text-right font-bold">{fmt(categoryRows.reduce((s, r) => s + r.prev, 0))}</TableCell>
                      <TableCell className="text-xs text-right font-bold">{fmt(categoryRows.reduce((s, r) => s + r.curr, 0))}</TableCell>
                      <TableCell className="text-xs text-right font-bold">
                        {fmt(categoryRows.reduce((s, r) => s + r.delta, 0))}
                      </TableCell>
                      <TableCell className="text-xs text-right font-bold">
                        {fmtPct(pct(categoryRows.reduce((s, r) => s + r.curr, 0), categoryRows.reduce((s, r) => s + r.prev, 0)))}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Property-Level Comparison */}
          {propertyComparison.length > 1 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Property-Level Budget Comparison</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="text-[10px] font-bold uppercase">Property</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">Revenue Change</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">Expense Change</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">CAM Change</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-right">NOI Change</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {propertyComparison.map(p => (
                      <TableRow key={p.property_id} className="hover:bg-slate-50">
                        <TableCell className="text-xs font-semibold">{p.property_name}</TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={p.revDelta} pctVal={pct(n(p.curr?.total_revenue), n(p.prev?.total_revenue))} />
                        </TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={p.expDelta} pctVal={pct(n(p.curr?.total_expenses), n(p.prev?.total_expenses))} />
                        </TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={p.camDelta} pctVal={pct(n(p.curr?.cam_total), n(p.prev?.cam_total))} />
                        </TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={p.noiDelta} pctVal={pct(n(p.curr?.noi), n(p.prev?.noi))} />
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[9px] uppercase ${
                            p.curr?.status === "approved" ? "bg-emerald-100 text-emerald-700" :
                            p.curr?.status === "under_review" ? "bg-red-100 text-red-700" :
                            "bg-slate-100 text-slate-600"
                          }`}>
                            {p.curr?.status?.replace("_", " ") || "No current budget"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* AI Insights from current budgets */}
          {currBudgets.some(b => b.ai_insights) && (
            <Card className="border-blue-100 bg-blue-50/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4 text-blue-600" />
                  AI Budget Insights
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {currBudgets.filter(b => b.ai_insights).map(b => (
                  <div key={b.id} className="rounded-xl bg-white/80 border border-blue-100 p-3">
                    <p className="text-[10px] font-bold text-blue-900 uppercase tracking-wide mb-1">
                      {b.name} (FY {b.budget_year || b.fiscal_year})
                    </p>
                    <p className="text-sm text-blue-800 leading-relaxed">{b.ai_insights}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {!hasBothYears && hasAnyBudget && (
            <Card className="border-slate-200">
              <CardContent className="p-6 text-center text-slate-500">
                <Info className="w-6 h-6 mx-auto mb-2 text-slate-400" />
                <p className="text-sm font-medium">
                  {currAgg.count === 0
                    ? `No FY ${currentYear} budgets found. Create a budget for the current year to see year-over-year comparison.`
                    : `No FY ${prevYear} budgets found. Prior year data is needed for year-over-year comparison.`
                  }
                </p>
                {currAgg.count === 0 && (
                  <Link to={createPageUrl("CreateBudget") + location.search}>
                    <Button className="mt-3" size="sm">Create {currentYear} Budget</Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
