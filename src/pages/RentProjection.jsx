import React, { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { differenceInDays } from "date-fns";
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
import { approvedLeaseFieldValue, hasApprovalSnapshot } from "@/lib/approvedLeaseSnapshot";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import {
  RENT_SCHEDULE_MONTHS,
  annualizedRunRateFromYearSchedule,
  buildLeaseYearSchedule,
  buildRentFiscalYearOptions,
  safeDate,
  scheduleHasMonthlyVariability,
  scheduleRowsForLease,
} from "@/lib/rentScheduleUtils";
import { supabase } from "@/services/supabaseClient";
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
import { createPageUrl, downloadCSV } from "@/utils";

const PROJECTION_MODES = [
  { value: "contracted_only", label: "Contracted Only" },
  { value: "include_approved_renewals", label: "Include Approved Renewals" },
  { value: "include_assumed_renewals", label: "Include Assumed Renewals" },
];

const APPROVED_FIELD_ALIASES = {
  commencement_date: ["commencement_date", "start_date", "lease_start_date", "term_start_date"],
  rent_commencement_date: ["rent_commencement_date", "commencement_date", "start_date", "lease_start_date", "term_start_date"],
  expiration_date: ["expiration_date", "end_date", "lease_end_date", "term_end_date"],
  tenant_rsf: ["tenant_rsf", "rentable_area_sqft", "square_footage", "total_sf"],
  monthly_rent: ["monthly_rent", "base_rent_monthly", "base_rent", "monthly_base_rent"],
  annual_rent: ["annual_rent", "base_rent_annual", "annual_base_rent", "yearly_rent"],
  rent_per_sf: ["rent_per_sf", "tenant_rent_per_rsf", "base_rent_psf"],
  escalation_type: ["escalation_type", "rent_escalation_type"],
  escalation_rate: ["escalation_rate", "renewal_escalation_percent", "renewal_escalation_pct"],
  escalation_timing: ["escalation_timing", "rent_escalation_timing"],
  free_rent_months: ["free_rent_months", "rent_abatement_months", "abatement_months", "free_rent"],
  renewal_options: ["renewal_options", "renewal_option_count", "option_to_renew", "renewal_option"],
  holdover_rent_multiplier: ["holdover_rent_multiplier", "holdover_multiplier"],
  renewal_escalation_percent: ["renewal_escalation_percent", "renewal_escalation_pct", "escalation_rate"],
  ground_rent: ["ground_rent", "ground_rent_monthly"],
  percentage_rent: ["percentage_rent", "percentage_rent_monthly"],
  tenant_name: ["tenant_name", "tenant", "tenant_legal_name", "tenant_name_raw", "lessee", "tenant_entity_name"],
  lease_type: ["lease_type", "expense_structure", "lease_structure", "cam_structure"],
};

const fmtMoney = (n, opts = {}) =>
  `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0, ...opts })}`;

function isApprovedLease(lease) {
  const abstract = String(lease?.abstract_status || "").toLowerCase();
  if (abstract === "approved") return true;
  return String(lease?.status || "").toLowerCase() === "approved";
}

function isLeaseStatusMatch(lease, filter) {
  const normalized = String(filter || "active").toLowerCase();
  if (normalized === "all") return true;
  const status = String(lease?.status || "").toLowerCase();
  if (normalized === "active") {
    // Historical approved-abstract workflow stored the lifecycle status as
    // "approved". Treat that as active for projection scope so approval does
    // not immediately hide the lease from this page.
    return status === "active" || (status === "approved" && isApprovedLease(lease));
  }
  return status === normalized;
}

function approvedFieldValue(lease, keys) {
  return approvedLeaseFieldValue(lease, keys, APPROVED_FIELD_ALIASES);
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
  const navigate = useNavigate();
  const currentYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [projectionMode, setProjectionMode] = useState("contracted_only");
  const [approvalStatus, setApprovalStatus] = useState("approved");
  const [leaseStatus, setLeaseStatus] = useState("active");
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

  useEffect(() => {
    setScopeProperty(hierarchy.propertyId || "all");
    setScopeBuilding(hierarchy.buildingId || "all");
    setScopeUnit(hierarchy.unitId || "all");
  }, [hierarchy.propertyId, hierarchy.buildingId, hierarchy.unitId]);

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
    approvalStatus,
    leaseStatus,
  });

  const scopedApprovedLeases = useMemo(() => {
    return leases
      .filter((lease) => {
        const matchApproval = approvalStatus === "all" ||
          (
            approvalStatus.toLowerCase() === "approved"
              ? isApprovedLease(lease)
              : String(lease.abstract_status || "").toLowerCase() === approvalStatus.toLowerCase()
          );
        const matchStatus = isLeaseStatusMatch(lease, leaseStatus);
        return matchApproval && matchStatus;
      })
      .filter((lease) =>
        matchesHierarchyScope(lease, hierarchy, {
          propertyKey: "property_id",
          unitKey: "unit_id",
        }),
      );
  }, [leases, hierarchy, approvalStatus, leaseStatus]);

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

  const authoritativeLeaseCount = Number(
    outputs?.summary?.lease_count ??
    (Array.isArray(outputs?.lease_summaries) ? outputs.lease_summaries.length : 0),
  );
  const hasAuthoritativeProjection = hasSnapshot && authoritativeLeaseCount > 0;

  const displayedStats = useMemo(() => {
    if (!hasAuthoritativeProjection) return liveStats;
    const summary = outputs?.summary || {};
    return {
      totalLeases: Number(summary.lease_count ?? liveStats.totalLeases),
      totalSf: liveStats.totalSf,
      totalAnnual: Number(summary.total_rent ?? liveStats.totalAnnual),
      totalMonthly: Number(summary.avg_monthly_rent ?? liveStats.totalMonthly),
      avgRentPerSf: Number(summary.avg_rent_psf ?? liveStats.avgRentPerSf),
      expiring12mo: liveStats.expiring12mo,
    };
  }, [hasAuthoritativeProjection, outputs, liveStats]);

  const authoritativeChart = useMemo(() => {
    if (!hasAuthoritativeProjection || !Array.isArray(outputs?.monthly_projections)) return [];
    return RENT_SCHEDULE_MONTHS.map((month, index) => {
      const row = outputs.monthly_projections[index] || {};
      return {
        month,
        current: Number(row.base_rent || 0),
        projected: Number(row.projected_rent || 0),
      };
    });
  }, [hasAuthoritativeProjection, outputs]);

  const leaseSummaryRows = useMemo(() => {
    const rows = Array.isArray(outputs?.lease_summaries) ? outputs.lease_summaries : [];
    if (!search) return rows;
    const needle = search.toLowerCase();
    return rows.filter((row) => {
      const haystack = [row.tenant_name, row.lease_type].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [outputs, search]);

  const liveLeaseSummaryRows = useMemo(() => {
    const rows = filteredApprovedLeases.map((lease) => {
      const annualizedRent = approvedLeaseAnnualRent(lease);
      const monthlyRent = approvedLeaseMonthlyRent(lease);
      const rsf = approvedLeaseRsf(lease);
      const tenantName = approvedFieldValue(lease, ["tenant_name"]) || lease.tenant_name || lease.tenant?.name;
      const leaseType = approvedFieldValue(lease, ["lease_type"]);
      return {
        lease_id: lease.id,
        tenant_name: tenantName || "Unknown",
        property_id: lease.property_id ?? null,
        building_id: lease.building_id ?? null,
        unit_id: lease.unit_id ?? null,
        lease_type: leaseType || (hasApprovalSnapshot(lease) ? null : lease.lease_type) || null,
        lease_start: approvedFieldValue(lease, ["commencement_date", "start_date"]) || "",
        rent_commencement_date: approvedFieldValue(lease, ["rent_commencement_date"]) || "",
        lease_end: approvedFieldValue(lease, ["expiration_date", "end_date"]) || "",
        monthly_rent: monthlyRent,
        rsf,
        fy_scheduled_rent: annualizedRent,
        annualized_rent: annualizedRent,
        rent_psf: rsf > 0 && annualizedRent > 0 ? annualizedRent / rsf : null,
        next_fy_scheduled_rent: 0,
        next_fy_zero_explanation: "Run Engine for authoritative monthly schedule.",
        rent_provenance: "Approved abstract",
      };
    });
    if (!search) return rows;
    const needle = search.toLowerCase();
    return rows.filter((row) => [row.tenant_name, row.lease_type].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [filteredApprovedLeases, search]);

  const baseDisplayedLeaseRows = hasAuthoritativeProjection ? leaseSummaryRows : liveLeaseSummaryRows;
  const displayedLeaseIds = useMemo(
    () => Array.from(new Set(baseDisplayedLeaseRows.map((row) => row.lease_id).filter(Boolean))),
    [baseDisplayedLeaseRows],
  );
  const { data: rentScheduleRows = [] } = useQuery({
    queryKey: ["rent-projection-rent-schedules", displayedLeaseIds],
    enabled: displayedLeaseIds.length > 0 && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rent_schedules")
        .select("*")
        .in("lease_id", displayedLeaseIds)
        .order("period_start", { ascending: true });
      if (error) {
        if (/does not exist|rent_schedules/i.test(error?.message || "")) return [];
        throw error;
      }
      return data || [];
    },
    retry: false,
  });
  const fiscalYearOptions = useMemo(() => buildRentFiscalYearOptions({
    selectedYear: fiscalYear,
    currentYear,
    leaseRows: baseDisplayedLeaseRows,
    scheduleRows: rentScheduleRows,
  }), [baseDisplayedLeaseRows, fiscalYear, currentYear, rentScheduleRows]);

  const displayedLeaseRows = useMemo(() => {
    return baseDisplayedLeaseRows.map((row) => {
      const leaseScheduleRows = scheduleRowsForLease(rentScheduleRows, row.lease_id, { projectionMode });
      const currentYearSchedule = buildLeaseYearSchedule(row, leaseScheduleRows, fiscalYear, { projectionMode });
      const nextYearSchedule = buildLeaseYearSchedule(row, leaseScheduleRows, fiscalYear + 1, { projectionMode });
      const annualizedRunRate = annualizedRunRateFromYearSchedule(currentYearSchedule) || Number(row.annualized_rent || 0);
      return {
        ...row,
        fy_scheduled_rent: currentYearSchedule.total,
        next_fy_scheduled_rent: nextYearSchedule.total,
        annualized_rent: annualizedRunRate,
        rent_psf: Number(row.rsf || 0) > 0 && annualizedRunRate > 0 ? annualizedRunRate / Number(row.rsf || 0) : row.rent_psf,
        next_fy_zero_explanation: nextYearSchedule.total > 0
          ? (scheduleHasMonthlyVariability(nextYearSchedule) ? "Monthly schedule includes rent changes or partial months." : "Monthly schedule calculated.")
          : "No scheduled rent in next fiscal year.",
        rent_provenance: currentYearSchedule.source,
        schedule_row_count: currentYearSchedule.storedRowCount,
        has_monthly_variability: scheduleHasMonthlyVariability(currentYearSchedule) || scheduleHasMonthlyVariability(nextYearSchedule),
        current_year_schedule: currentYearSchedule,
        next_year_schedule: nextYearSchedule,
      };
    });
  }, [baseDisplayedLeaseRows, fiscalYear, projectionMode, rentScheduleRows]);

  const liveProjectionChart = useMemo(() => {
    return RENT_SCHEDULE_MONTHS.map((month, index) => ({
      month,
      current: Math.round(displayedLeaseRows.reduce((sum, row) => sum + Number(row.current_year_schedule?.months?.[index]?.amount || 0), 0) * 100) / 100,
      projected: Math.round(displayedLeaseRows.reduce((sum, row) => sum + Number(row.next_year_schedule?.months?.[index]?.amount || 0), 0) * 100) / 100,
    }));
  }, [displayedLeaseRows]);
  const displayedChart = hasAuthoritativeProjection && authoritativeChart.length > 0 ? authoritativeChart : liveProjectionChart;

  const currentScheduledAnnual = displayedChart.reduce((sum, row) => sum + Number(row.current || 0), 0);
  const projectedAnnual = displayedChart.reduce((sum, row) => sum + Number(row.projected || 0), 0);
  const scheduledRentPerSf = Number(displayedStats.totalSf || 0) > 0 ? currentScheduledAnnual / Number(displayedStats.totalSf || 0) : 0;
  const currentMonthlyAvg = currentScheduledAnnual / 12;
  const projectedMonthlyAvg = projectedAnnual / 12;
  const yoyChange =
    currentScheduledAnnual > 0
      ? ((projectedAnnual - currentScheduledAnnual) / currentScheduledAnnual) * 100
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
          approval_status: approvalStatus,
          status: leaseStatus,
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
    if (displayedLeaseRows.length === 0) {
      toast.info("No approved leases to export.");
      return;
    }

    downloadCSV(
      displayedLeaseRows.map((row) => {
        const monthColumns = Object.fromEntries(
          RENT_SCHEDULE_MONTHS.map((month, index) => [
            `${fiscalYear}_${month.toLowerCase()}`,
            Number(row.current_year_schedule?.months?.[index]?.amount || 0),
          ]),
        );
        const nextMonthColumns = Object.fromEntries(
          RENT_SCHEDULE_MONTHS.map((month, index) => [
            `${fiscalYear + 1}_${month.toLowerCase()}`,
            Number(row.next_year_schedule?.months?.[index]?.amount || 0),
          ]),
        );
        return {
          tenant: row.tenant_name || "",
          property: hierarchy.propertyById.get(row.property_id)?.name || row.property_id || "",
          building: hierarchy.buildingById.get(row.building_id)?.name || "",
          unit: hierarchy.unitById.get(row.unit_id)?.unit_number || row.unit_id || "",
          lease_type: row.lease_type || "",
          lease_start: row.lease_start || "",
          rent_commencement_date: row.rent_commencement_date || "",
          lease_end: row.lease_end || "",
          rsf: row.rsf || 0,
          projection_mode: projectionMode,
          schedule_source: row.rent_provenance || "",
          schedule_row_count: row.schedule_row_count || 0,
          fy_scheduled_rent: Math.round(Number(row.fy_scheduled_rent || 0)),
          run_rate_annualized_rent: Math.round(Number(row.annualized_rent || 0)),
          rent_psf: row.rent_psf == null ? "" : Number(row.rent_psf).toFixed(2),
          has_monthly_variability: Boolean(row.has_monthly_variability),
          ...monthColumns,
          next_fy_scheduled_rent: Math.round(Number(row.next_fy_scheduled_rent || 0)),
          ...nextMonthColumns,
          next_fy_note: row.next_fy_zero_explanation || "",
        };
      }),
      `rent-projection-monthly-${fiscalYear}-${projectionMode}.csv`,
    );
  };
  const openLeaseSchedule = (row) => {
    if (!row?.lease_id) return;
    navigate(createPageUrl("LeaseRentSchedule", { id: row.lease_id, fiscal_year: fiscalYear }));
  };

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <PageHeader
        icon={Building2}
        title="Rent Projection"
        subtitle={`${filteredApprovedLeases.length} approved lease${filteredApprovedLeases.length === 1 ? "" : "s"} in scope`}
        iconColor="from-blue-700 to-blue-600"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(fiscalYear)} onValueChange={(value) => setFiscalYear(Number(value))}>
            <SelectTrigger className="w-32">
              <CalendarDays className="w-3.5 h-3.5 mr-1 text-slate-400" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fiscalYearOptions.map((year) => (
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

          <Select value={approvalStatus} onValueChange={setApprovalStatus}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Approval Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="needs_review">Needs Review</SelectItem>
              <SelectItem value="all">All Approvals</SelectItem>
            </SelectContent>
          </Select>

          <Select value={leaseStatus} onValueChange={setLeaseStatus}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Lease Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="terminated">Terminated</SelectItem>
              <SelectItem value="all">All Statuses</SelectItem>
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
        portfolios={hierarchy.orgScopedPortfolios}
        properties={hierarchy.scopedProperties}
        buildings={hierarchy.scopedBuildings}
        units={hierarchy.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
        syncToUrl
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">FY Scheduled Rent</p>
            <p className="text-2xl font-bold text-slate-900">{fmtMoney(currentScheduledAnnual)}</p>
            <p className="text-[10px] text-slate-400">{fmtMoney(currentMonthlyAvg)}/mo avg</p>
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
            <p className="text-2xl font-bold text-slate-700">${Number(scheduledRentPerSf || 0).toFixed(2)}</p>
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

      {selectedPropertyId && !hasAuthoritativeProjection && (
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

      {hasAuthoritativeProjection && (
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
          {displayedChart.length === 0 || displayedStats.totalLeases === 0 ? (
            <p className="text-center py-12 text-sm text-slate-400">
              Approved lease abstracts appear here immediately after approval. Run the engine for authoritative monthly projection snapshots.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={displayedChart}>
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
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Monthly Budget Basis</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                FY totals are the sum of these monthly cells. Partial months use actual-day proration.
              </p>
            </div>
            <Badge variant="outline" className="text-[10px]">
              {PROJECTION_MODES.find((mode) => mode.value === projectionMode)?.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="sticky left-0 z-10 min-w-[180px] bg-slate-50 text-[11px] font-semibold uppercase text-slate-500">Tenant</TableHead>
                {RENT_SCHEDULE_MONTHS.map((month) => (
                  <TableHead key={month} className="min-w-[78px] text-right text-[11px] font-semibold uppercase text-slate-500">{month}</TableHead>
                ))}
                <TableHead className="min-w-[100px] text-right text-[11px] font-semibold uppercase text-slate-500">FY Total</TableHead>
                <TableHead className="min-w-[110px] text-right text-[11px] font-semibold uppercase text-slate-500">Run Rate</TableHead>
                <TableHead className="min-w-[120px] text-[11px] font-semibold uppercase text-slate-500">Basis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedLeaseRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={16} className="py-10 text-center text-sm text-slate-400">No lease schedules in scope.</TableCell>
                </TableRow>
              ) : displayedLeaseRows.map((row, index) => (
                <TableRow key={`monthly-${row.lease_id || index}`} className="hover:bg-slate-50">
                  <TableCell className="sticky left-0 z-10 bg-white text-xs font-semibold text-slate-900">
                    <button type="button" className="text-left hover:underline" onClick={() => openLeaseSchedule(row)}>
                      {row.tenant_name || "-"}
                    </button>
                    <div className="mt-0.5 text-[10px] font-normal text-slate-500">
                      {row.schedule_row_count ? `${row.schedule_row_count} schedule row${row.schedule_row_count === 1 ? "" : "s"}` : row.rent_provenance}
                    </div>
                  </TableCell>
                  {RENT_SCHEDULE_MONTHS.map((month, monthIndex) => {
                    const monthRow = row.current_year_schedule?.months?.[monthIndex] || {};
                    const highlight = monthRow.isPartial || monthRow.hasChange;
                    return (
                      <TableCell
                        key={`${row.lease_id || index}-${month}`}
                        className={`text-right font-mono text-xs ${highlight ? "bg-amber-50 text-amber-800" : "text-slate-800"}`}
                        title={highlight ? "Partial month or rent change inside month" : "Full-month scheduled rent"}
                      >
                        {fmtMoney(monthRow.amount)}
                        {highlight && <div className="text-[9px] font-sans uppercase">{monthRow.hasChange ? "Change" : "Partial"}</div>}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-mono text-sm font-semibold">{fmtMoney(row.fy_scheduled_rent)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmtMoney(row.annualized_rent)}</TableCell>
                  <TableCell className="text-xs text-slate-500">
                    {row.rent_provenance || "-"}
                    {row.has_monthly_variability && <div className="mt-0.5 text-[10px] font-semibold text-amber-700">Variable monthly schedule</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">Lease Projection Detail</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Open a lease schedule to compare prior, selected, and next fiscal-year monthly rent in a dedicated table.
              </p>
            </div>
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
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500 text-right">Schedule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leasesLoading ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : !hasAuthoritativeProjection && displayedLeaseRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center py-12 text-sm text-slate-400">
                    No approved leases match the current scope. Approved abstracts appear here immediately; run the engine for authoritative monthly schedule rows.
                  </TableCell>
                </TableRow>
              ) : displayedLeaseRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center py-12 text-sm text-slate-400">
                    No approved leases match the current scope.
                  </TableCell>
                </TableRow>
              ) : (
                displayedLeaseRows.map((row, index) => {
                  const property = row.property_id ? hierarchy.propertyById.get(row.property_id) : null;
                  const unit = row.unit_id ? hierarchy.unitById.get(row.unit_id) : null;
                  return (
                    <TableRow
                      key={row.lease_id || `${row.tenant_name || "lease"}-${index}`}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => openLeaseSchedule(row)}
                    >
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
                      <TableCell className="text-sm font-mono text-right font-semibold">
                        <div>{fmtMoney(row.annualized_rent)}</div>
                        {row.rent_provenance && (
                          <div className="text-[9px] text-slate-400 font-sans font-normal uppercase">
                            {row.rent_provenance}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm font-mono text-right">{row.rent_psf == null ? "—" : `$${Number(row.rent_psf).toFixed(2)}`}</TableCell>
                      <TableCell className="text-sm font-mono text-right">{fmtMoney(row.next_fy_scheduled_rent)}</TableCell>
                      <TableCell className="text-xs text-slate-500 max-w-[320px]">{row.next_fy_zero_explanation || "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={!row.lease_id}
                          onClick={(event) => {
                            event.stopPropagation();
                            openLeaseSchedule(row);
                          }}
                        >
                          Schedule
                        </Button>
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
