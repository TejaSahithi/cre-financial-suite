import React, { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { differenceInDays, differenceInMonths, parseISO } from "date-fns";
import {
  Loader2,
  RefreshCw,
  AlertCircle,
  Building2,
  TrendingUp,
  CalendarDays,
  Download,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { toast } from "sonner";

import useOrgQuery from "@/hooks/useOrgQuery";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import ScopeSelector from "@/components/ScopeSelector";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { downloadCSV } from "@/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtMoney = (n, opts = {}) =>
  `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0, ...opts })}`;

function safeDate(value) {
  if (!value) return null;
  try {
    const d = typeof value === "string" ? parseISO(value) : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function leaseMonthlyRent(lease) {
  if (lease.monthly_rent) return Number(lease.monthly_rent);
  if (lease.annual_rent) return Number(lease.annual_rent) / 12;
  if (lease.base_rent) return Number(lease.base_rent);
  return 0;
}

function leaseAnnualRent(lease) {
  if (lease.annual_rent) return Number(lease.annual_rent);
  return leaseMonthlyRent(lease) * 12;
}

function leaseSquareFootage(lease) {
  return Number(lease.total_sf || lease.square_footage || 0);
}

function leaseRentPerSf(lease) {
  if (lease.rent_per_sf) return Number(lease.rent_per_sf);
  const sf = leaseSquareFootage(lease);
  const annual = leaseAnnualRent(lease);
  return sf > 0 ? annual / sf : 0;
}

/**
 * Compute the projected monthly rent stream for a single lease across the
 * twelve months of the requested fiscal year. Honours start/end dates and
 * applies the lease's escalation_rate at the configured cadence.
 */
function projectLeaseMonthly(lease, fiscalYear) {
  const start = safeDate(lease.start_date);
  const end = safeDate(lease.end_date);
  const baseMonthly = leaseMonthlyRent(lease);
  const escalationRate = Number(lease.escalation_rate || 0) / 100;
  const escalationTiming = lease.escalation_timing || "lease_anniversary";

  const months = MONTHS.map((label, idx) => {
    const monthDate = new Date(fiscalYear, idx, 15);
    if (start && monthDate < start) return { month: label, rent: 0 };
    if (end && monthDate > end) return { month: label, rent: 0 };

    let rent = baseMonthly;

    if (escalationRate > 0 && start) {
      let escalations = 0;
      if (escalationTiming === "calendar_year") {
        escalations = Math.max(0, fiscalYear - start.getFullYear());
        // Don't apply Jan-1 step until we're actually past the new year mark.
        if (escalations > 0 && idx === 0 && start.getMonth() !== 0) {
          // first month of new fiscal year still applies the new step
        }
      } else {
        // lease_anniversary: integer years elapsed since start
        const monthsElapsed = differenceInMonths(monthDate, start);
        escalations = Math.max(0, Math.floor(monthsElapsed / 12));
      }
      rent = baseMonthly * Math.pow(1 + escalationRate, escalations);
    }

    return { month: label, rent: Math.round(rent) };
  });

  return months;
}

export default function RentProjection() {
  const location = useLocation();
  const currentYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [search, setSearch] = useState("");

  const { data: leases = [], isLoading: leasesLoading } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : null;

  // Snapshot data is optional — we still render the live rent roll if absent.
  const { snapshot, outputs, isFetching, refetch, hasSnapshot } = useSnapshotQuery({
    engineType: "lease",
    propertyId: selectedPropertyId,
    fiscalYear,
  });

  const { trigger: triggerCompute, isTriggering } = useComputeTrigger();

  // Filter leases by hierarchy scope + UI filters.
  const scopedLeases = useMemo(() => {
    return leases.filter((lease) =>
      matchesHierarchyScope(lease, scope, {
        propertyKey: "property_id",
        unitKey: "unit_id",
      })
    );
  }, [leases, scope]);

  const filteredLeases = useMemo(() => {
    return scopedLeases.filter((lease) => {
      if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
      if (scopeBuilding !== "all") {
        const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) : null;
        if (unit?.building_id !== scopeBuilding) return false;
      }
      if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
      if (search) {
        const haystack = [lease.tenant_name, lease.lease_type]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase())
          .join(" ");
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [scopedLeases, scopeProperty, scopeBuilding, scopeUnit, search, scope.unitById]);

  // Aggregate rent roll metrics from live lease data.
  const stats = useMemo(() => {
    const totalLeases = filteredLeases.length;
    const totalSf = filteredLeases.reduce((sum, l) => sum + leaseSquareFootage(l), 0);
    const totalAnnual = filteredLeases.reduce((sum, l) => sum + leaseAnnualRent(l), 0);
    const totalMonthly = filteredLeases.reduce((sum, l) => sum + leaseMonthlyRent(l), 0);
    const avgRentPerSf = totalSf > 0 ? totalAnnual / totalSf : 0;
    const today = new Date();
    const expiring12mo = filteredLeases.filter((l) => {
      const end = safeDate(l.end_date);
      if (!end) return false;
      const days = differenceInDays(end, today);
      return days > 0 && days <= 365;
    }).length;
    return { totalLeases, totalSf, totalAnnual, totalMonthly, avgRentPerSf, expiring12mo };
  }, [filteredLeases]);

  // Live 12-month projection — sums every lease's projected monthly rent.
  const monthlyChart = useMemo(() => {
    const buckets = MONTHS.map((label) => ({ month: label, current: 0, projected: 0 }));
    filteredLeases.forEach((lease) => {
      const currentSeries = projectLeaseMonthly(lease, fiscalYear);
      const projectedSeries = projectLeaseMonthly(lease, fiscalYear + 1);
      currentSeries.forEach((row, idx) => {
        buckets[idx].current += row.rent;
      });
      projectedSeries.forEach((row, idx) => {
        buckets[idx].projected += row.rent;
      });
    });
    return buckets.map((b) => ({
      month: b.month,
      current: Math.round(b.current),
      projected: Math.round(b.projected),
    }));
  }, [filteredLeases, fiscalYear]);

  const projectedAnnual = monthlyChart.reduce((sum, b) => sum + b.projected, 0);
  const projectedMonthlyAvg = projectedAnnual / 12;
  const yoyChange =
    stats.totalAnnual > 0 ? ((projectedAnnual - stats.totalAnnual) / stats.totalAnnual) * 100 : null;

  const handleTriggerCompute = async () => {
    if (!selectedPropertyId) {
      toast.info("Select a single property to run the lease engine");
      return;
    }
    try {
      await triggerCompute(
        "compute-lease",
        { property_id: selectedPropertyId, fiscal_year: fiscalYear },
        { successMessage: "Computation queued — refresh shortly to view snapshot" }
      );
      setTimeout(() => refetch(), 3000);
    } catch {
      toast.error("Failed to trigger computation");
    }
  };

  const handleExport = () => {
    const rows = filteredLeases.map((lease) => {
      const property = lease.property_id ? scope.propertyById.get(lease.property_id) : null;
      const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) : null;
      const building = unit?.building_id ? scope.buildingById.get(unit.building_id) : null;
      return {
        tenant: lease.tenant_name || "",
        property: property?.name || "",
        building: building?.name || "",
        unit: unit?.unit_number || lease.unit_number || "",
        type: getLeaseFieldLabel("lease_type", lease.lease_type) || lease.lease_type || "",
        start_date: lease.start_date || "",
        end_date: lease.end_date || "",
        sf: leaseSquareFootage(lease),
        rent_per_sf: leaseRentPerSf(lease).toFixed(2),
        monthly_rent: Math.round(leaseMonthlyRent(lease)),
        annual_rent: Math.round(leaseAnnualRent(lease)),
        escalation_rate: lease.escalation_rate || 0,
      };
    });
    if (rows.length === 0) {
      toast.info("No rows to export");
      return;
    }
    downloadCSV(rows, `rent-roll-${fiscalYear}.csv`);
  };

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <PageHeader
        icon={Building2}
        title="Rent Roll & Projection"
        subtitle={`${stats.totalLeases} active lease${stats.totalLeases === 1 ? "" : "s"} · ${fmtMoney(stats.totalAnnual)} annual rent`}
        iconColor="from-blue-600 to-indigo-700"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(fiscalYear)} onValueChange={(v) => setFiscalYear(Number(v))}>
            <SelectTrigger className="w-32">
              <CalendarDays className="w-3.5 h-3.5 mr-1 text-slate-400" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  FY {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={handleTriggerCompute}
            disabled={isTriggering || !selectedPropertyId}
            className="bg-[#1a2744] hover:bg-[#243b67]"
          >
            {isTriggering ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            Run Engine
          </Button>
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

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Total Annual Rent</p>
            <p className="text-2xl font-bold text-slate-900">{fmtMoney(stats.totalAnnual)}</p>
            <p className="text-[10px] text-slate-400">{fmtMoney(stats.totalMonthly)}/mo</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Projected (Next FY)</p>
            <p className="text-2xl font-bold text-emerald-600">{fmtMoney(projectedAnnual)}</p>
            <p className="text-[10px] text-emerald-500">{fmtMoney(projectedMonthlyAvg)}/mo avg</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">YoY Change</p>
            <p className="text-2xl font-bold">
              {yoyChange === null ? (
                "—"
              ) : (
                <span className={yoyChange >= 0 ? "text-emerald-600" : "text-red-500"}>
                  {yoyChange >= 0 ? "+" : ""}
                  {yoyChange.toFixed(1)}%
                </span>
              )}
            </p>
            <p className="text-[10px] text-slate-400">FY{fiscalYear} → FY{fiscalYear + 1}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-400">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Avg Rent / SF</p>
            <p className="text-2xl font-bold text-slate-700">${stats.avgRentPerSf.toFixed(2)}</p>
            <p className="text-[10px] text-slate-400">{Number(stats.totalSf).toLocaleString()} SF leased</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-red-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Expiring &lt; 12 mo</p>
            <p className="text-2xl font-bold text-red-600">{stats.expiring12mo}</p>
            <p className="text-[10px] text-slate-400">Renewal risk</p>
          </CardContent>
        </Card>
      </div>

      {/* Snapshot status banner */}
      {!hasSnapshot && selectedPropertyId && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800">No engine snapshot for this property yet</p>
              <p className="text-xs text-amber-600 mt-0.5">
                Showing a live rent roll computed from lease records. Click <strong>Run Engine</strong> to
                generate a full computation snapshot with CAM allocation and recovery schedules.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {hasSnapshot && (
        <div className="text-[11px] text-slate-400">
          Snapshot computed {new Date(snapshot.computed_at).toLocaleString()} ·
          {" "}
          {outputs?.tenant_schedules?.length || 0} tenant schedules in engine output
        </div>
      )}

      {/* Monthly projection chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            Monthly Rent — FY{fiscalYear} vs FY{fiscalYear + 1}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredLeases.length === 0 ? (
            <p className="text-center py-12 text-sm text-slate-400">
              No leases in current scope — projection unavailable.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                />
                <Tooltip formatter={(value) => fmtMoney(value)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="current" name={`FY${fiscalYear} Rent`} fill="#1a2744" radius={[4, 4, 0, 0]} barSize={22} />
                <Line
                  type="monotone"
                  dataKey="projected"
                  name={`FY${fiscalYear + 1} Projection`}
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Rent Roll table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Rent Roll</CardTitle>
            <div className="relative w-64">
              <Input
                placeholder="Search tenant or type…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Property</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Unit</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Type</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Start</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">End</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">SF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Rent/SF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Monthly</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Annual</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Escalation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leasesLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredLeases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-12 text-sm text-slate-400">
                    No leases match the current scope.
                  </TableCell>
                </TableRow>
              ) : (
                filteredLeases.map((lease) => {
                  const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) : null;
                  const property = lease.property_id ? scope.propertyById.get(lease.property_id) : null;
                  const sf = leaseSquareFootage(lease);
                  const monthly = leaseMonthlyRent(lease);
                  const annual = leaseAnnualRent(lease);
                  const rentPerSf = leaseRentPerSf(lease);
                  const end = safeDate(lease.end_date);
                  const expiring = end && differenceInDays(end, new Date()) <= 365 && end > new Date();
                  return (
                    <TableRow key={lease.id} className="hover:bg-slate-50">
                      <TableCell className="text-sm font-medium text-slate-900">
                        {lease.tenant_name || "—"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{property?.name || "—"}</TableCell>
                      <TableCell className="text-sm text-slate-600">
                        {unit?.unit_number || lease.unit_number || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {getLeaseFieldLabel("lease_type", lease.lease_type) || lease.lease_type || "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">{lease.start_date || "—"}</TableCell>
                      <TableCell className="text-xs">
                        <span className={expiring ? "text-red-600 font-medium" : "text-slate-500"}>
                          {lease.end_date || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm font-mono text-right">
                        {sf > 0 ? sf.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-sm font-mono text-right">
                        {rentPerSf > 0 ? `$${rentPerSf.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-sm font-mono text-right">{fmtMoney(monthly)}</TableCell>
                      <TableCell className="text-sm font-mono text-right font-bold">
                        {fmtMoney(annual)}
                      </TableCell>
                      <TableCell>
                        {lease.escalation_rate ? (
                          <Badge variant="outline" className="text-[10px]">
                            {lease.escalation_rate}%
                            {lease.escalation_type
                              ? ` ${getLeaseFieldLabel("escalation_type", lease.escalation_type)}`
                              : ""}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
