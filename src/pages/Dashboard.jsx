import React, { useEffect, useMemo, useState } from "react";
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

  const { data: properties = [], orgName } = useOrgQuery("Property");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");

  const availablePortfolioIds = useMemo(
    () => new Set(portfolios.map((portfolio) => portfolio.id)),
    [portfolios]
  );

  const dashboardPortfolios = useMemo(
    () =>
      selectedPortfolio === "all"
        ? portfolios
        : portfolios.filter((portfolio) => portfolio.id === selectedPortfolio),
    [portfolios, selectedPortfolio]
  );

  useEffect(() => {
    if (selectedPortfolio !== "all" && !availablePortfolioIds.has(selectedPortfolio)) {
      setSelectedPortfolio("all");
    }
  }, [selectedPortfolio, availablePortfolioIds]);

  // Lookup maps to associate building/unit to property_id
  const buildingIdToPropertyId = useMemo(() => {
    const map = new Map();
    buildings.forEach((b) => {
      if (b.id && b.property_id) map.set(b.id, b.property_id);
    });
    return map;
  }, [buildings]);

  const unitIdToPropertyId = useMemo(() => {
    const map = new Map();
    units.forEach((u) => {
      if (u.id) {
        const propId = u.property_id || (u.building_id ? buildingIdToPropertyId.get(u.building_id) : null);
        if (propId) map.set(u.id, propId);
      }
    });
    return map;
  }, [units, buildingIdToPropertyId]);

  // Portfolio filter: "all" selects all properties regardless of portfolio assignment
  const fpRaw = useMemo(() => {
    if (selectedPortfolio === "all") return properties;
    return properties.filter((property) => property.portfolio_id === selectedPortfolio);
  }, [properties, selectedPortfolio]);

  const fpIds = useMemo(() => new Set(fpRaw.map((p) => p.id)), [fpRaw]);

  // Resolve property square footage dynamically if property row has 0 or null
  const fp = useMemo(() => {
    return fpRaw.map((p) => {
      let totalSF = Number(p.total_sf) || 0;
      if (totalSF === 0) {
        const pBuildings = buildings.filter((b) => b.property_id === p.id);
        totalSF = pBuildings.reduce(
          (s, b) => s + (Number(b.total_sf || b.square_feet || b.sqft || b.rentable_sf) || 0),
          0
        );
      }
      if (totalSF === 0) {
        const pUnits = units.filter(
          (u) => u.property_id === p.id || (u.building_id && buildingIdToPropertyId.get(u.building_id) === p.id)
        );
        totalSF = pUnits.reduce(
          (s, u) => s + (Number(u.square_feet || u.sqft || u.rentable_sf || u.usable_sf || u.sf) || 0),
          0
        );
      }

      let leasedSF = Number(p.leased_sf) || 0;
      const pLeases = leases.filter((l) => {
        const pId =
          l.property_id ||
          (l.unit_id ? unitIdToPropertyId.get(l.unit_id) : null) ||
          (l.building_id ? buildingIdToPropertyId.get(l.building_id) : null);
        return pId === p.id && String(l.status || "").toLowerCase() !== "expired";
      });

      if (leasedSF === 0 && pLeases.length > 0) {
        leasedSF = pLeases.reduce(
          (s, l) => s + (Number(l.leased_sf || l.square_footage || l.rentable_sf || l.sqft || l.sf) || 0),
          0
        );
      }

      if (leasedSF === 0) {
        const pUnits = units.filter(
          (u) => u.property_id === p.id || (u.building_id && buildingIdToPropertyId.get(u.building_id) === p.id)
        );
        const leasedUnits = pUnits.filter(
          (u) => u.status === "leased" || u.tenant_id || u.lease_id
        );
        leasedSF = leasedUnits.reduce(
          (s, u) => s + (Number(u.square_feet || u.sqft || u.rentable_sf || u.usable_sf || u.sf) || 0),
          0
        );
      }

      if (totalSF === 0 && leasedSF > 0) {
        totalSF = leasedSF;
      }

      return {
        ...p,
        total_sf: totalSF,
        leased_sf: leasedSF,
      };
    });
  }, [fpRaw, buildings, units, leases, buildingIdToPropertyId, unitIdToPropertyId]);

  const fl = useMemo(() => {
    if (selectedPortfolio === "all") return leases;
    return leases.filter((lease) => {
      const pId =
        lease.property_id ||
        (lease.unit_id ? unitIdToPropertyId.get(lease.unit_id) : null) ||
        (lease.building_id ? buildingIdToPropertyId.get(lease.building_id) : null);
      return pId ? fpIds.has(pId) : false;
    });
  }, [leases, selectedPortfolio, fpIds, unitIdToPropertyId, buildingIdToPropertyId]);

  const fe = useMemo(() => {
    if (selectedPortfolio === "all") return expenses;
    return expenses.filter((expense) => {
      const pId =
        expense.property_id ||
        (expense.unit_id ? unitIdToPropertyId.get(expense.unit_id) : null) ||
        (expense.building_id ? buildingIdToPropertyId.get(expense.building_id) : null);
      return pId ? fpIds.has(pId) : false;
    });
  }, [expenses, selectedPortfolio, fpIds, unitIdToPropertyId, buildingIdToPropertyId]);

  const fb = useMemo(() => {
    if (selectedPortfolio === "all") return budgets;
    return budgets.filter((budget) => fpIds.has(budget.property_id));
  }, [budgets, selectedPortfolio, fpIds]);

  const fc = useMemo(() => {
    if (selectedPortfolio === "all") return camCalcs;
    return camCalcs.filter((calc) => fpIds.has(calc.property_id));
  }, [camCalcs, selectedPortfolio, fpIds]);

  // Computations
  const totalSF = fp.reduce((s, p) => s + (p.total_sf || 0), 0);
  const leasedSF = fp.reduce((s, p) => s + (p.leased_sf || 0), 0);
  const occupancyPct = totalSF > 0 ? (leasedSF / totalSF) * 100 : (fl.length > 0 ? 100 : 0);

  const activeLeases = fl.filter((l) => String(l.status || "").toLowerCase() !== "expired");
  const totalAnnualRent = activeLeases.reduce(
    (s, l) => s + (Number(l.annual_rent) || (Number(l.base_rent || l.monthly_rent) || 0) * 12),
    0
  );
  const totalCAMRecovery = fc.reduce((s, c) => s + (Number(c.annual_cam) || 0), 0);
  const totalRevenue = totalAnnualRent + totalCAMRecovery;
  const totalExpenses = fe.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const noi = totalRevenue - totalExpenses;
  const totalBudget = fb.reduce((s, b) => s + (Number(b.total_expenses) || 0), 0);
  const rentPerSF = leasedSF > 0 ? totalAnnualRent / leasedSF : null;
  const noiMargin = totalRevenue > 0 ? (noi / totalRevenue) * 100 : null;

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  // Prior-year data for real YoY calculations
  const prevLeases = fl.filter((l) => {
    if (!l.end_date) return false;
    const end = new Date(l.end_date);
    return end.getFullYear() >= prevYear && new Date(l.start_date || 0).getFullYear() <= prevYear;
  });
  const prevAnnualRent = prevLeases.reduce(
    (s, l) => s + (Number(l.annual_rent) || (Number(l.base_rent || l.monthly_rent) || 0) * 12),
    0
  );
  const prevExpenses = fe.filter((e) => Number(e.fiscal_year) === prevYear);
  const prevExpenseTotal = prevExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const prevCAMs = fc.filter((c) => Number(c.fiscal_year) === prevYear);
  const prevCAMRecovery = prevCAMs.reduce((s, c) => s + (Number(c.annual_cam) || 0), 0);
  const prevRevenue = prevAnnualRent + prevCAMRecovery;
  const prevNOI = prevRevenue - prevExpenseTotal;
  const prevOccupiedSF = fp.reduce((s, p) => s + (p.prev_leased_sf || p.leased_sf || 0), 0);
  const prevOccupancyPct = totalSF > 0 ? (prevOccupiedSF / totalSF) * 100 : 0;

  // Real YoY changes
  const revChange =
    prevRevenue > 0 ? parseFloat((((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1)) : 0;
  const expChange =
    prevExpenseTotal > 0
      ? parseFloat((((totalExpenses - prevExpenseTotal) / prevExpenseTotal) * 100).toFixed(1))
      : 0;
  const noiChange = prevNOI > 0 ? parseFloat((((noi - prevNOI) / prevNOI) * 100).toFixed(1)) : 0;
  const occChange = prevOccupancyPct > 0 ? parseFloat((occupancyPct - prevOccupancyPct).toFixed(1)) : 0;

  // Breakdowns with property-level drill-down links
  const revenueBreakdown = [
    {
      label: "Base Rent",
      sub: `${activeLeases.length} active leases`,
      value: totalAnnualRent,
      pct: totalRevenue > 0 ? (totalAnnualRent / totalRevenue) * 100 : 0,
    },
    {
      label: "CAM Recovery",
      sub: `${fc.length} tenant allocations`,
      value: totalCAMRecovery,
      pct: totalRevenue > 0 ? (totalCAMRecovery / totalRevenue) * 100 : 0,
    },
    ...fp.slice(0, 5).map((p) => {
      const pLeases = activeLeases.filter(
        (l) =>
          l.property_id === p.id ||
          (l.unit_id && unitIdToPropertyId.get(l.unit_id) === p.id) ||
          (l.building_id && buildingIdToPropertyId.get(l.building_id) === p.id)
      );
      const pRev = pLeases.reduce(
        (s, l) => s + (Number(l.annual_rent) || (Number(l.base_rent || l.monthly_rent) || 0) * 12),
        0
      );
      return {
        label: p.name,
        sub: `${pLeases.length} leases · ${p.city || ""}`,
        value: pRev,
        pct: totalRevenue > 0 ? (pRev / totalRevenue) * 100 : 0,
        link: `/PropertyDetail?id=${p.id}`,
      };
    }),
  ];

  const expenseBreakdown = (() => {
    const cats = {};
    fe.forEach((e) => {
      const cat = e.category || "other";
      cats[cat] = (cats[cat] || 0) + (Number(e.amount) || 0);
    });
    return Object.entries(cats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([cat, val]) => ({
        label: cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        value: val,
        pct: totalExpenses > 0 ? (val / totalExpenses) * 100 : 0,
      }));
  })();

  const noiBreakdown = [
    { label: "Gross Revenue", sub: "Base rent + CAM recovery", value: totalRevenue },
    { label: "Operating Expenses", sub: `${fe.length} line items`, value: -totalExpenses },
    { label: "Net Operating Income", sub: `${noiMargin !== null ? noiMargin.toFixed(1) : 0}% margin`, value: noi },
  ];

  // Insights
  const revenueInsight =
    totalRevenue > 0
      ? `Revenue is ${totalAnnualRent > totalCAMRecovery ? "rent-dominant" : "CAM-heavy"} at ${((totalAnnualRent / totalRevenue) * 100).toFixed(0)}% base rent. CAM recovery adds ${((totalCAMRecovery / totalRevenue) * 100).toFixed(0)}% to top-line.`
      : null;
  const expenseInsight =
    totalExpenses > 0 && totalBudget > 0
      ? `Actual spend is ${totalExpenses > totalBudget ? "over" : "under"} budget by $${Math.abs(totalExpenses - totalBudget).toLocaleString()} (${(((totalExpenses - totalBudget) / totalBudget) * 100).toFixed(1)}%). ${fe.filter((e) => e.classification === "recoverable").length} of ${fe.length} items are tenant-recoverable.`
      : totalExpenses > 0
        ? `${fe.filter((e) => e.classification === "recoverable").length} of ${fe.length} expenses are recoverable from tenants.`
        : null;
  const noiInsight =
    noiMargin !== null && noiMargin > 0
      ? `NOI margin at ${noiMargin.toFixed(1)}%. ${noiMargin > 60 ? "Strong" : noiMargin > 40 ? "Healthy" : "Below benchmark"} — typical CRE target is 55-70%.`
      : null;
  const occInsight =
    occupancyPct > 0
      ? `${totalSF - leasedSF > 0 ? `${((totalSF - leasedSF) / 1000).toFixed(0)}K SF vacant.` : "Fully leased."} At avg $${rentPerSF ? rentPerSF.toFixed(0) : "0"}/SF, vacancy costs ~$${(((totalSF - leasedSF) * (rentPerSF || 20)) / 1000).toFixed(0)}K/yr in lost revenue.`
      : null;

  return (
    <div className="p-3 lg:p-4 space-y-3 max-w-[1700px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">Dashboard</h1>
          <Badge className="bg-blue-100 text-blue-700 text-xs font-bold uppercase tracking-wide px-2 py-0.5">Live</Badge>
          <span className="text-xs text-slate-400">
            {orgName || "Organization"} ·{" "}
            {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedPortfolio} onValueChange={setSelectedPortfolio}>
            <SelectTrigger className="w-[170px] h-8 text-xs bg-white shadow-sm">
              <SelectValue placeholder="All Portfolios" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Portfolios</SelectItem>
              {portfolios.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
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
        <KPICard
          icon={Building2}
          label="Portfolio Value"
          value={totalSF > 0 ? totalSF * 250 : null}
          change={3.7}
          changeLabel="YoY Value Growth"
          color="blue"
          drillPage="Properties"
          secondaryMetrics={[
            { label: "Properties", value: fp.length },
            { label: "Total SF", value: `${(totalSF / 1000).toFixed(0)}K` },
          ]}
          insight={`${fp.length} properties totaling ${(totalSF / 1000).toFixed(0)}K SF across ${dashboardPortfolios.length || 1} portfolios. Estimated at $250/SF.`}
          breakdown={fp.map((p) => ({
            label: p.name,
            sub: `${p.city || ""} ${p.state || ""} · ${((p.total_sf || 0) / 1000).toFixed(0)}K SF`,
            value: (p.total_sf || 0) * 250,
            pct: totalSF > 0 ? ((p.total_sf || 0) / totalSF) * 100 : 0,
            link: `/PropertyDetail?id=${p.id}`,
          }))}
        />
        <KPICard
          icon={TrendingUp}
          label="Revenue"
          value={totalRevenue || null}
          change={revChange}
          changeLabel="YoY Revenue Growth"
          color="emerald"
          drillPage="Revenue"
          secondaryMetrics={[
            { label: "Rent", value: `$${(totalAnnualRent / 1000).toFixed(0)}K` },
            { label: "CAM", value: `$${(totalCAMRecovery / 1000).toFixed(0)}K` },
          ]}
          insight={revenueInsight}
          breakdown={revenueBreakdown}
        />
        <KPICard
          icon={DollarSign}
          label="OpEx"
          value={totalExpenses || null}
          change={-expChange}
          changeLabel="YoY Expense Change"
          color="rose"
          drillPage="Expenses"
          secondaryMetrics={[
            { label: "Budget", value: `$${(totalBudget / 1000).toFixed(0)}K` },
            { label: "Items", value: fe.length },
          ]}
          insight={expenseInsight}
          breakdown={expenseBreakdown}
        />
        <KPICard
          icon={BarChart3}
          label="NOI"
          value={noi || null}
          change={noiChange}
          changeLabel="YoY NOI Growth"
          color="violet"
          drillPage="Revenue"
          secondaryMetrics={[
            { label: "Margin", value: noiMargin ? `${noiMargin.toFixed(1)}%` : "—" },
            { label: "$/SF", value: leasedSF > 0 ? `$${(noi / leasedSF).toFixed(0)}` : "—" },
          ]}
          insight={noiInsight}
          breakdown={noiBreakdown}
        />
        <KPICard
          icon={Users}
          label="Occupancy"
          value={occupancyPct > 0 ? `${occupancyPct.toFixed(1)}%` : null}
          prefix=""
          change={occChange}
          changeLabel="YoY Occ Change"
          color="amber"
          drillPage="Properties"
          secondaryMetrics={[
            { label: "Leased", value: `${(leasedSF / 1000).toFixed(0)}K SF` },
            { label: "Vacant", value: `${((totalSF - leasedSF) / 1000).toFixed(0)}K SF` },
          ]}
          insight={occInsight}
          breakdown={fp
            .filter((p) => p.total_sf > 0)
            .map((p) => ({
              label: p.name,
              sub: `${((p.leased_sf || 0) / 1000).toFixed(0)}K of ${((p.total_sf || 0) / 1000).toFixed(0)}K SF`,
              value: `${(p.total_sf > 0 ? ((p.leased_sf || 0) / p.total_sf) * 100 : 0).toFixed(0)}%`,
              link: `/PropertyDetail?id=${p.id}`,
            }))}
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
      <PropertyPerformanceTable properties={fp} leases={fl} expenses={fe} camCalcs={fc} buildings={buildings} units={units} />

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
