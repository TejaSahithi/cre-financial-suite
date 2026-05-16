import React, { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { differenceInDays, parseISO } from "date-fns";
import {
  AlertCircle,
  Building2,
  CalendarDays,
  Download,
  Loader2,
  RefreshCw,
  TrendingUp,
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
import { Input } from "@/components/ui/input";
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
import { downloadCSV } from "@/utils";

const PROJECTION_MODES = [
  { value: "contracted_only", label: "Contracted Only" },
  { value: "include_approved_renewals", label: "Include Approved Renewals" },
  { value: "include_assumed_renewals", label: "Include Assumed Renewals" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtMoney = (n, opts = {}) =>
  `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0, ...opts })}`;

function safeDate(value) {
  if (!value) return null;
  try {
    const d = typeof value === "string" ? parseISO(value) : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function isApprovedLease(lease) {
  const abstract = String(lease?.abstract_status || "").toLowerCase();
  if (abstract === "approved") return true;
  return String(lease?.status || "").toLowerCase() === "approved";
}

function approvedFieldValue(lease, keys) {
  const candidates = Array.isArray(keys) ? keys : [keys];
  const snapshotFields = lease?.abstract_snapshot?.fields || {};
  const extractionFields = lease?.extraction_data?.fields || {};
  const extractedFields = lease?.extracted_fields || {};

  for (const key of candidates) {
    const snapshotValue = snapshotFields?.[key]?.value;
    if (snapshotValue !== undefined && snapshotValue !== null && snapshotValue !== "") return snapshotValue;
    if (lease?.[key] !== undefined && lease?.[key] !== null && lease?.[key] !== "") return lease[key];
    const extracted = extractedFields?.[key];
    if (extracted && typeof extracted === "object" && "value" in extracted && extracted.value !== "") return extracted.value;
    if (extracted !== undefined && extracted !== null && extracted !== "") return extracted;
    const extraction = extractionFields?.[key];
    if (extraction && typeof extraction === "object" && "value" in extraction && extraction.value !== "") return extraction.value;
    if (extraction !== undefined && extraction !== null && extraction !== "") return extraction;
  }
  return null;
}

function approvedLeaseRsf(lease) {
  return Number(
    approvedFieldValue(lease, ["tenant_rsf", "rentable_area_sqft", "square_footage", "total_sf"]) || 0,
  );
}

function approvedLeaseAnnualRent(lease) {
  const annual = Number(approvedFieldValue(lease, ["annual_rent"]) || 0);
  if (annual > 0) return annual;
  const monthly = Number(approvedFieldValue(lease, ["monthly_rent", "base_rent_monthly"]) || 0);
  if (monthly > 0) return monthly * 12;
  const rsf = approvedLeaseRsf(lease);
  const rentPerSf = Number(approvedFieldValue(lease, ["rent_per_sf"]) || 0);
  return rsf > 0 && rentPerSf > 0 ? rsf * rentPerSf : 0;
}

function approvedLeaseMonthlyRent(lease) {
  const monthly = Number(approvedFieldValue(lease, ["monthly_rent", "base_rent_monthly"]) || 0);
  if (monthly > 0) return monthly;
  const annual = approvedLeaseAnnualRent(lease);
  return annual > 0 ? annual / 12 : 0;
}

function scopeSelection(propertyId, buildingId, unitId) {
  if (unitId && unitId !== "all") return { scopeLevel: "unit", scopeId: unitId };
  if (buildingId && buildingId !== "all") return { scopeLevel: "building", scopeId: buildingId };
  return { scopeLevel: "property", scopeId: propertyId && propertyId !== "all" ? propertyId : null };
}

export default function RentProjection() {
  const location = useLocation();
  const currentYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [projectionMode, setProjectionMode] = useState("contracted_only");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [search, setSearch] = useState("");

  const { data: leases = [], isLoading: leasesLoading } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { trigger: triggerCompute, isTriggering } = useComputeTrigger();

  const hierarchy = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units],
  );

  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : null;
  const selectedBuildingId = scopeBuilding !== "all" ? scopeBuilding : null;
  const selectedUnitId = scopeUnit !== "all" ? scopeUnit : null;
  const selectedScope = scopeSelection(selectedPropertyId, selectedBuildingId, selectedUnitId);

  const { snapshot, outputs, isFetching, refetch, hasSnapshot } = useSnapshotQuery({
    engineType: "lease",
    propertyId: selectedPropertyId,
    fiscalYear,
    scopeLevel: selectedScope.scopeLevel,
    scopeId: selectedScope.scopeId,
    projectionMode,
  });

  const scopedApprovedLeases = useMemo(() => {
    return leases
      .filter(isApprovedLease)
      .filter((lease) =>
        matchesHierarchyScope(lease, hierarchy, {
          propertyKey: "property_id",
          unitKey: "unit_id",
        }),
      );
  }, [leases, hierarchy]);

  const filteredApprovedLeases = useMemo(() => {
    return scopedApprovedLeases.filter((lease) => {
      if (selectedPropertyId && lease.property_id !== selectedPropertyId) return false;
      if (selectedBuildingId) {
        const unit = lease.unit_id ? hierarchy.unitById.get(lease.unit_id) : null;
        if (unit?.building_id !== selectedBuildingId) return false;
      }
      if (selectedUnitId && lease.unit_id !== selectedUnitId) return false;
      if (search) {
        const haystack = [
          lease.tenant_name,
          lease.lease_type,
          approvedFieldValue(lease, ["tenant_name"]),
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase())
          .join(" ");
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [scopedApprovedLeases, selectedPropertyId, selectedBuildingId, selectedUnitId, search, hierarchy.unitById]);

  const liveStats = useMemo(() => {
    const totalLeases = filteredApprovedLeases.length;
    const totalSf = filteredApprovedLeases.reduce((sum, lease) => sum + approvedLeaseRsf(lease), 0);
    const totalAnnual = filteredApprovedLeases.reduce((sum, lease) => sum + approvedLeaseAnnualRent(lease), 0);
    const totalMonthly = filteredApprovedLeases.reduce((sum, lease) => sum + approvedLeaseMonthlyRent(lease), 0);
    const avgRentPerSf = totalSf > 0 ? totalAnnual / totalSf : 0;
    const today = new Date();
    const expiring12mo = filteredApprovedLeases.filter((lease) => {
      const end = safeDate(approvedFieldValue(lease, ["expiration_date", "end_date"]));
      if (!end) return false;
      const days = differenceInDays(end, today);
      return days > 0 && days <= 365;
    }).length;
    return { totalLeases, totalSf, totalAnnual, totalMonthly, avgRentPerSf, expiring12mo };
  }, [filteredApprovedLeases]);

  const displayedStats = useMemo(() => {
    if (!hasSnapshot) return liveStats;
    const summary = outputs?.summary || {};
    return {
      totalLeases: Number(summary.lease_count ?? liveStats.totalLeases),
      totalSf: liveStats.totalSf,
      totalAnnual: Number(summary.total_rent ?? liveStats.totalAnnual),
      totalMonthly: Number(summary.avg_monthly_rent ?? liveStats.totalMonthly),
      avgRentPerSf: Number(summary.avg_rent_psf ?? liveStats.avgRentPerSf),
      expiring12mo: liveStats.expiring12mo,
    };
  }, [hasSnapshot, outputs, liveStats]);

  const authoritativeChart = useMemo(() => {
    if (!hasSnapshot || !Array.isArray(outputs?.monthly_projections)) return [];
    return MONTHS.map((month, index) => {
      const row = outputs.monthly_projections[index] || {};
      return {
        month,
        current: Number(row.base_rent || 0),
        projected: Number(row.projected_rent || 0),
      };
    });
  }, [hasSnapshot, outputs]);

  const leaseSummaryRows = useMemo(() => {
    const rows = Array.isArray(outputs?.lease_summaries) ? outputs.lease_summaries : [];
    if (!search) return rows;
    const needle = search.toLowerCase();
    return rows.filter((row) => {
      const haystack = [row.tenant_name, row.lease_type].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [outputs, search]);

  const projectedAnnual = authoritativeChart.reduce((sum, row) => sum + Number(row.projected || 0), 0);
  const projectedMonthlyAvg = projectedAnnual / 12;
  const yoyChange =
    displayedStats.totalAnnual > 0
      ? ((projectedAnnual - displayedStats.totalAnnual) / displayedStats.totalAnnual) * 100
      : null;

  const handleTriggerCompute = async () => {
    if (!selectedPropertyId) {
      toast.info("Select a property before running the rent projection engine.");
      return;
    }

    try {
      await triggerCompute(
        "compute-lease",
        {
          property_id: selectedPropertyId,
          building_id: selectedBuildingId,
          unit_id: selectedUnitId,
          fiscal_year: fiscalYear,
          projection_mode: projectionMode,
          scope_level: selectedScope.scopeLevel,
          scope_id: selectedScope.scopeId,
        },
        { successMessage: "Rent projection computation queued." },
      );
      setTimeout(() => refetch(), 3000);
    } catch {
      toast.error("Failed to trigger rent projection.");
    }
  };

  const handleExport = () => {
    if (hasSnapshot && leaseSummaryRows.length > 0) {
      downloadCSV(
        leaseSummaryRows.map((row) => ({
          tenant: row.tenant_name || "",
          property: row.property_id || "",
          building: row.building_id || "",
          unit: row.unit_id || "",
          lease_type: row.lease_type || "",
          lease_start: row.lease_start || "",
          rent_commencement_date: row.rent_commencement_date || "",
          lease_end: row.lease_end || "",
          rsf: row.rsf || 0,
          fy_scheduled_rent: Math.round(Number(row.fy_scheduled_rent || 0)),
          annualized_rent: Math.round(Number(row.annualized_rent || 0)),
          rent_psf: row.rent_psf == null ? "" : Number(row.rent_psf).toFixed(2),
          next_fy_scheduled_rent: Math.round(Number(row.next_fy_scheduled_rent || 0)),
          next_fy_note: row.next_fy_zero_explanation || "",
        })),
        `rent-projection-${fiscalYear}-${projectionMode}.csv`,
      );
      return;
    }

    if (filteredApprovedLeases.length === 0) {
      toast.info("No approved leases to export.");
      return;
    }

    downloadCSV(
      filteredApprovedLeases.map((lease) => ({
        tenant: approvedFieldValue(lease, ["tenant_name"]) || "",
        property: hierarchy.propertyById.get(lease.property_id)?.name || "",
        building: hierarchy.buildingById.get(hierarchy.unitById.get(lease.unit_id)?.building_id)?.name || "",
        unit: hierarchy.unitById.get(lease.unit_id)?.unit_number || lease.unit_number || "",
        lease_type: getLeaseFieldLabel("lease_type", lease.lease_type) || lease.lease_type || "",
        lease_start: approvedFieldValue(lease, ["commencement_date", "start_date"]) || "",
        rent_commencement_date: approvedFieldValue(lease, ["rent_commencement_date"]) || "",
        lease_end: approvedFieldValue(lease, ["expiration_date", "end_date"]) || "",
        rsf: approvedLeaseRsf(lease),
        annual_rent: Math.round(approvedLeaseAnnualRent(lease)),
      })),
      `approved-leases-${fiscalYear}.csv`,
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <PageHeader
        icon={Building2}
        title="Rent Projection"
        subtitle={`${filteredApprovedLeases.length} approved lease${filteredApprovedLeases.length === 1 ? "" : "s"} in scope`}
        iconColor="from-blue-600 to-indigo-700"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(fiscalYear)} onValueChange={(value) => setFiscalYear(Number(value))}>
            <SelectTrigger className="w-32">
              <CalendarDays className="w-3.5 h-3.5 mr-1 text-slate-400" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((year) => (
                <SelectItem key={year} value={String(year)}>
                  FY {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={projectionMode} onValueChange={setProjectionMode}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECTION_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
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
        properties={hierarchy.scopedProperties}
        buildings={hierarchy.scopedBuildings}
        units={hierarchy.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">FY Scheduled Rent</p>
            <p className="text-2xl font-bold text-slate-900">{fmtMoney(displayedStats.totalAnnual)}</p>
            <p className="text-[10px] text-slate-400">{fmtMoney(displayedStats.totalMonthly)}/mo avg</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Next FY Scheduled</p>
            <p className="text-2xl font-bold text-emerald-600">{fmtMoney(projectedAnnual)}</p>
            <p className="text-[10px] text-emerald-500">{fmtMoney(projectedMonthlyAvg)}/mo avg</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">YoY Change</p>
            <p className="text-2xl font-bold">
              {yoyChange == null ? "—" : (
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
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Annualized Rent / SF</p>
            <p className="text-2xl font-bold text-slate-700">${Number(displayedStats.avgRentPerSf || 0).toFixed(2)}</p>
            <p className="text-[10px] text-slate-400">{Number(displayedStats.totalSf || 0).toLocaleString()} RSF</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-red-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Expiring &lt; 12 mo</p>
            <p className="text-2xl font-bold text-red-600">{displayedStats.expiring12mo}</p>
            <p className="text-[10px] text-slate-400">Approved lease risk</p>
          </CardContent>
        </Card>
      </div>

      {!selectedPropertyId && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="text-sm text-amber-800">
              Select a property to compute an authoritative rent projection snapshot. Building and unit scopes run inside the selected property.
            </div>
          </CardContent>
        </Card>
      )}

      {selectedPropertyId && !hasSnapshot && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800">No authoritative snapshot for this scope yet</p>
              <p className="text-xs text-amber-600 mt-0.5">
                Rent Projection now reads from approved lease abstracts plus approved rent schedule rows. Run the engine to compute FY{fiscalYear} for the selected scope and projection mode.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {hasSnapshot && (
        <div className="text-[11px] text-slate-400">
          Snapshot computed {new Date(snapshot.computed_at).toLocaleString()} · {outputs?.summary?.lease_count || 0} approved lease(s) · {PROJECTION_MODES.find((mode) => mode.value === projectionMode)?.label}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            Monthly Scheduled Rent — FY{fiscalYear} vs FY{fiscalYear + 1}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasSnapshot ? (
            <p className="text-center py-12 text-sm text-slate-400">
              Run the engine to view authoritative monthly rent projections for this scope.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={authoritativeChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                <Tooltip formatter={(value) => fmtMoney(value)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="current" name={`FY${fiscalYear} Scheduled`} fill="#1a2744" radius={[4, 4, 0, 0]} barSize={22} />
                <Line
                  type="monotone"
                  dataKey="projected"
                  name={`FY${fiscalYear + 1} Scheduled`}
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Lease Projection Detail</CardTitle>
            <div className="relative w-64">
              <Input
                placeholder="Search tenant or type..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
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
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease Start</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Rent Start</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease End</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">RSF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">FY{fiscalYear}</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Annualized</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Rent / SF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">FY{fiscalYear + 1}</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Next FY Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leasesLoading ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : !hasSnapshot ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center py-12 text-sm text-slate-400">
                    Authoritative projection rows appear here after the engine runs for the selected scope.
                  </TableCell>
                </TableRow>
              ) : leaseSummaryRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center py-12 text-sm text-slate-400">
                    No approved leases match the current scope.
                  </TableCell>
                </TableRow>
              ) : (
                leaseSummaryRows.map((row) => {
                  const property = row.property_id ? hierarchy.propertyById.get(row.property_id) : null;
                  const unit = row.unit_id ? hierarchy.unitById.get(row.unit_id) : null;
                  return (
                    <TableRow key={row.lease_id} className="hover:bg-slate-50">
                      <TableCell className="text-sm font-medium text-slate-900">{row.tenant_name || "—"}</TableCell>
                      <TableCell className="text-sm text-slate-600">{property?.name || "—"}</TableCell>
                      <TableCell className="text-sm text-slate-600">{unit?.unit_number || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {getLeaseFieldLabel("lease_type", row.lease_type) || row.lease_type || "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">{row.lease_start || "—"}</TableCell>
                      <TableCell className="text-xs text-slate-500">{row.rent_commencement_date || "—"}</TableCell>
                      <TableCell className="text-xs text-slate-500">{row.lease_end || "—"}</TableCell>
                      <TableCell className="text-sm font-mono text-right">{Number(row.rsf || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right">{fmtMoney(row.fy_scheduled_rent)}</TableCell>
                      <TableCell className="text-sm font-mono text-right font-semibold">{fmtMoney(row.annualized_rent)}</TableCell>
                      <TableCell className="text-sm font-mono text-right">{row.rent_psf == null ? "—" : `$${Number(row.rent_psf).toFixed(2)}`}</TableCell>
                      <TableCell className="text-sm font-mono text-right">{fmtMoney(row.next_fy_scheduled_rent)}</TableCell>
                      <TableCell className="text-xs text-slate-500 max-w-[320px]">{row.next_fy_zero_explanation || "—"}</TableCell>
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
