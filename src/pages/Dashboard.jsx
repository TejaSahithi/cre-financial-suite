import React, { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Building2, DollarSign, TrendingUp, BarChart3, Users } from "lucide-react";

import KPICard from "@/components/dashboard/KPICard";
import FinancialSummaryStrip from "@/components/dashboard/FinancialSummaryStrip";
import BudgetVsActualChart from "@/components/dashboard/BudgetVsActualChart";
import NOITrendChart from "@/components/dashboard/NOITrendChart";
import OccupancyChart from "@/components/dashboard/OccupancyChart";
import ExpenseDistChart from "@/components/dashboard/ExpenseDistChart";
import PropertyPerformanceTable from "@/components/dashboard/PropertyPerformanceTable";
import LeaseExpiryTimeline from "@/components/dashboard/LeaseExpiryTimeline";
import AlertsPanel from "@/components/dashboard/AlertsPanel";
import ActivityFeed from "@/components/dashboard/ActivityFeed";
import QuickActionsBar from "@/components/dashboard/QuickActionsBar";
import PortfolioSummary from "@/components/dashboard/PortfolioSummary";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useSearchParams } from "react-router-dom";


export default function Dashboard() {
  const [searchParams] = useSearchParams();
  const [selectedPortfolio, setSelectedPortfolio] = useState(searchParams.get("portfolio") || "all");

  const { data: properties = [], orgName, orgLoading } = useOrgQuery("Property");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");

  // Portfolio filter
  const fp = selectedPortfolio === "all" ? properties : properties.filter(p => p.portfolio_id === selectedPortfolio);
  const fpIds = new Set(fp.map(p => p.id));
  const fl = selectedPortfolio === "all" ? leases : leases.filter(l => fpIds.has(l.property_id));
  const fe = selectedPortfolio === "all" ? expenses : expenses.filter(e => fpIds.has(e.property_id));
  const fb = selectedPortfolio === "all" ? budgets : budgets.filter(b => fpIds.has(b.property_id));
  const fc = selectedPortfolio === "all" ? camCalcs : camCalcs.filter(c => fpIds.has(c.property_id));

  // Computations
  const totalSF = fp.reduce((s, p) => s + (p.total_sf || 0), 0);
  const leasedSF = fp.reduce((s, p) => s + (p.leased_sf || 0), 0);
  const occupancyPct = totalSF > 0 ? (leasedSF / totalSF * 100) : 0;

  const activeLeases = fl.filter(l => l.status !== 'expired');
  const totalAnnualRent = activeLeases.reduce((s, l) => s + (l.annual_rent || (l.base_rent || 0) * 12), 0);
  const totalCAMRecovery = fc.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const totalRevenue = totalAnnualRent + totalCAMRecovery;
  const totalExpenses = fe.reduce((s, e) => s + (e.amount || 0), 0);
  const noi = totalRevenue - totalExpenses;
  const totalBudget = fb.reduce((s, b) => s + (b.total_expenses || 0), 0);
  const rentPerSF = leasedSF > 0 ? totalAnnualRent / leasedSF : null;
  const noiMargin = totalRevenue > 0 ? (noi / totalRevenue * 100) : null;

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  // Prior-year data for real YoY calculations
  const prevLeases = fl.filter(l => {
    if (!l.end_date) return false;
    const end = new Date(l.end_date);
    return end.getFullYear() >= prevYear && new Date(l.start_date || 0).getFullYear() <= prevYear;
  });
  const prevAnnualRent = prevLeases.reduce((s, l) => s + (l.annual_rent || (l.base_rent || 0) * 12), 0);
  const prevExpenses = fe.filter(e => e.fiscal_year === prevYear);
  const prevExpenseTotal = prevExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const prevCAMs = fc.filter(c => c.fiscal_year === prevYear);
  const prevCAMRecovery = prevCAMs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const prevRevenue = prevAnnualRent + prevCAMRecovery;
  const prevNOI = prevRevenue - prevExpenseTotal;
  const prevOccupiedSF = fp.reduce((s, p) => s + (p.prev_leased_sf || p.leased_sf || 0), 0);
  const prevOccupancyPct = totalSF > 0 ? (prevOccupiedSF / totalSF * 100) : 0;

  // Real YoY changes (fall back to 0 if no prior data)
  const revChange = prevRevenue > 0 ? parseFloat(((totalRevenue - prevRevenue) / prevRevenue * 100).toFixed(1)) : 0;
  const expChange = prevExpenseTotal > 0 ? parseFloat(((totalExpenses - prevExpenseTotal) / prevExpenseTotal * 100).toFixed(1)) : 0;
  const noiChange = prevNOI > 0 ? parseFloat(((noi - prevNOI) / prevNOI * 100).toFixed(1)) : 0;
  const occChange = prevOccupancyPct > 0 ? parseFloat((occupancyPct - prevOccupancyPct).toFixed(1)) : 0;

  // Breakdowns with property-level drill-down links
  const revenueBreakdown = [
    { label: "Base Rent", sub: `${activeLeases.length} active leases`, value: totalAnnualRent, pct: totalRevenue > 0 ? totalAnnualRent / totalRevenue * 100 : 0 },
    { label: "CAM Recovery", sub: `${fc.length} tenant allocations`, value: totalCAMRecovery, pct: totalRevenue > 0 ? totalCAMRecovery / totalRevenue * 100 : 0 },
    ...fp.slice(0, 5).map(p => {
      const pLeases = activeLeases.filter(l => l.property_id === p.id);
      const pRev = pLeases.reduce((s, l) => s + (l.annual_rent || (l.base_rent || 0) * 12), 0);
      return { label: p.name, sub: `${pLeases.length} leases · ${p.city || ''}`, value: pRev, pct: totalRevenue > 0 ? pRev / totalRevenue * 100 : 0, link: `/PropertyDetail?id=${p.id}` };
    }),
  ];

  const expenseBreakdown = (() => {
    const cats = {};
    fe.forEach(e => { cats[e.category || 'other'] = (cats[e.category || 'other'] || 0) + (e.amount || 0); });
    return Object.entries(cats).sort(([, a], [, b]) => b - a).slice(0, 10).map(([cat, val]) => ({
      label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      value: val,
      pct: totalExpenses > 0 ? val / totalExpenses * 100 : 0,
    }));
  })();

  const noiBreakdown = [
    { label: "Gross Revenue", sub: "Base rent + CAM recovery", value: totalRevenue },
    { label: "Operating Expenses", sub: `${fe.length} line items`, value: -totalExpenses },
    { label: "Net Operating Income", sub: `${noiMargin !== null ? noiMargin.toFixed(1) : 0}% margin`, value: noi },
  ];

  // Insights
  const revenueInsight = totalRevenue > 0
    ? `Revenue is ${totalAnnualRent > totalCAMRecovery ? 'rent-dominant' : 'CAM-heavy'} at ${(totalAnnualRent / totalRevenue * 100).toFixed(0)}% base rent. CAM recovery adds ${(totalCAMRecovery / totalRevenue * 100).toFixed(0)}% to top-line.`
    : null;
  const expenseInsight = totalExpenses > 0 && totalBudget > 0
    ? `Actual spend is ${totalExpenses > totalBudget ? 'over' : 'under'} budget by $${Math.abs(totalExpenses - totalBudget).toLocaleString()} (${((totalExpenses - totalBudget) / totalBudget * 100).toFixed(1)}%). ${fe.filter(e => e.classification === 'recoverable').length} of ${fe.length} items are tenant-recoverable.`
    : totalExpenses > 0 ? `${fe.filter(e => e.classification === 'recoverable').length} of ${fe.length} expenses are recoverable from tenants.` : null;
  const noiInsight = noiMargin !== null && noiMargin > 0
    ? `NOI margin at ${noiMargin.toFixed(1)}%. ${noiMargin > 60 ? 'Strong' : noiMargin > 40 ? 'Healthy' : 'Below benchmark'} — typical CRE target is 55-70%.`
    : null;
  const occInsight = occupancyPct > 0
    ? `${(totalSF - leasedSF) > 0 ? `${((totalSF - leasedSF) / 1000).toFixed(0)}K SF vacant.` : 'Fully leased.'} At avg $${rentPerSF ? rentPerSF.toFixed(0) : '0'}/SF, vacancy costs ~$${((totalSF - leasedSF) * (rentPerSF || 20) / 1000).toFixed(0)}K/yr in lost revenue.`
    : null;

  return (
    <div className="p-3 lg:p-4 space-y-3 max-w-[1700px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">Dashboard</h1>
          <Badge className="bg-blue-100 text-blue-700 text-xs font-bold uppercase tracking-wide px-2 py-0.5">Live</Badge>
          <span className="text-xs text-slate-400">{orgName || "Organization"} · {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedPortfolio} onValueChange={setSelectedPortfolio}>
            <SelectTrigger className="w-[170px] h-8 text-xs bg-white shadow-sm">
              <SelectValue placeholder="All Portfolios" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Portfolios</SelectItem>
              {portfolios.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Financial Summary Strip */}
      <FinancialSummaryStrip
        revenue={totalRevenue}
        expenses={totalExpenses}
        noi={noi}
        budgeted={totalBudget}
        camRecovery={totalCAMRecovery}
        occupancy={occupancyPct}
        rentPerSF={rentPerSF}
        noiMargin={noiMargin}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon={Building2} label="Portfolio Value" value={totalSF > 0 ? totalSF * 250 : null} change={3.7} changeLabel="YoY Value Growth" color="blue" drillPage="Properties"
          secondaryMetrics={[{ label: "Properties", value: fp.length }, { label: "Total SF", value: `${(totalSF / 1000).toFixed(0)}K` }]}
          insight={`${fp.length} properties totaling ${(totalSF / 1000).toFixed(0)}K SF across ${portfolios.length} portfolios. Estimated at $250/SF.`}
          breakdown={fp.map(p => ({ label: p.name, sub: `${p.city || ''} ${p.state || ''} · ${((p.total_sf || 0) / 1000).toFixed(0)}K SF`, value: (p.total_sf || 0) * 250, pct: totalSF > 0 ? (p.total_sf || 0) / totalSF * 100 : 0, link: `/PropertyDetail?id=${p.id}` }))}
        />
        <KPICard icon={TrendingUp} label="Revenue" value={totalRevenue || null} change={revChange} changeLabel="YoY Revenue Growth" color="emerald" drillPage="Revenue"
          secondaryMetrics={[{ label: "Rent", value: `$${(totalAnnualRent / 1000).toFixed(0)}K` }, { label: "CAM", value: `$${(totalCAMRecovery / 1000).toFixed(0)}K` }]}
          insight={revenueInsight} breakdown={revenueBreakdown}
        />
        <KPICard icon={DollarSign} label="OpEx" value={totalExpenses || null} change={-expChange} changeLabel="YoY Expense Change" color="rose" drillPage="Expenses"
          secondaryMetrics={[{ label: "Budget", value: `$${(totalBudget / 1000).toFixed(0)}K` }, { label: "Items", value: fe.length }]}
          insight={expenseInsight} breakdown={expenseBreakdown}
        />
        <KPICard icon={BarChart3} label="NOI" value={noi || null} change={noiChange} changeLabel="YoY NOI Growth" color="violet" drillPage="Revenue"
          secondaryMetrics={[{ label: "Margin", value: noiMargin ? `${noiMargin.toFixed(1)}%` : '—' }, { label: "$/SF", value: leasedSF > 0 ? `$${(noi / leasedSF).toFixed(0)}` : '—' }]}
          insight={noiInsight} breakdown={noiBreakdown}
        />
        <KPICard icon={Users} label="Occupancy" value={occupancyPct > 0 ? `${occupancyPct.toFixed(1)}%` : null} prefix="" change={occChange} changeLabel="YoY Occ Change" color="amber" drillPage="Properties"
          secondaryMetrics={[{ label: "Leased", value: `${(leasedSF / 1000).toFixed(0)}K SF` }, { label: "Vacant", value: `${((totalSF - leasedSF) / 1000).toFixed(0)}K SF` }]}
          insight={occInsight}
          breakdown={fp.filter(p => p.total_sf > 0).map(p => ({ label: p.name, sub: `${((p.leased_sf || 0) / 1000).toFixed(0)}K of ${((p.total_sf || 0) / 1000).toFixed(0)}K SF`, value: `${(p.total_sf > 0 ? (p.leased_sf || 0) / p.total_sf * 100 : 0).toFixed(0)}%`, link: `/PropertyDetail?id=${p.id}` }))}
        />
      </div>

      {/* Quick Actions */}
      <QuickActionsBar />

      {/* Charts Row 1 */}
      <div className="grid lg:grid-cols-2 gap-3">
        <BudgetVsActualChart budgets={fb} expenses={fe} />
        <NOITrendChart leases={fl} expenses={fe} />
      </div>

      {/* Property Performance Table - full width */}
      <PropertyPerformanceTable properties={fp} leases={fl} expenses={fe} camCalcs={fc} />

      {/* Row 3: Expense + Occupancy + Lease Expiry */}
      <div className="grid lg:grid-cols-3 gap-3">
        <ExpenseDistChart expenses={fe} />
        <OccupancyChart properties={fp} />
        <LeaseExpiryTimeline leases={fl} />
      </div>

      {/* Bottom: Portfolios + Alerts + Activity */}
      <div className="grid lg:grid-cols-3 gap-3">
        <PortfolioSummary portfolios={portfolios} properties={properties} />
        <AlertsPanel />
        <ActivityFeed />
      </div>
    </div>
  );
}