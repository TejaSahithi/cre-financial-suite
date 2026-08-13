import React, { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CalendarDays,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import useOrgQuery from "@/hooks/useOrgQuery";
import { approvedLeaseFieldValue, hasApprovalSnapshot } from "@/lib/approvedLeaseSnapshot";
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import {
  RENT_SCHEDULE_MONTHS,
  buildLeaseYearSchedule,
  buildRentFiscalYearOptions,
  scheduleRowsForLease,
} from "@/lib/rentScheduleUtils";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl, downloadCSV } from "@/utils";

const FIELD_ALIASES = {
  commencement_date: ["commencement_date", "start_date", "lease_start_date", "term_start_date"],
  rent_commencement_date: ["rent_commencement_date", "commencement_date", "start_date", "lease_start_date", "term_start_date"],
  expiration_date: ["expiration_date", "end_date", "lease_end_date", "term_end_date"],
  tenant_rsf: ["tenant_rsf", "rentable_area_sqft", "square_footage", "total_sf"],
  monthly_rent: ["monthly_rent", "base_rent_monthly", "base_rent", "monthly_base_rent"],
  annual_rent: ["annual_rent", "base_rent_annual", "annual_base_rent", "yearly_rent"],
  rent_per_sf: ["rent_per_sf", "tenant_rent_per_rsf", "base_rent_psf"],
  lease_type: ["lease_type", "expense_structure", "lease_structure", "cam_structure"],
};

const fmtMoney = (n, opts = {}) =>
  `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0, ...opts })}`;

function approvedFieldValue(lease, keys) {
  return approvedLeaseFieldValue(lease, keys, FIELD_ALIASES);
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

function buildLeaseProjectionRow(lease) {
  if (!lease) return null;
  const annualizedRent = approvedLeaseAnnualRent(lease);
  const monthlyRent = approvedLeaseMonthlyRent(lease);
  const rsf = approvedLeaseRsf(lease);
  const tenantName = approvedFieldValue(lease, ["tenant_name"]);
  const leaseType = approvedFieldValue(lease, ["lease_type"]);
  return {
    lease_id: lease.id,
    tenant_name: tenantName || (hasApprovalSnapshot(lease) ? "Unknown" : lease.tenant_name) || "Unknown",
    property_id: lease.property_id ?? null,
    building_id: lease.building_id ?? null,
    unit_id: lease.unit_id ?? null,
    lease_type: leaseType || (hasApprovalSnapshot(lease) ? null : lease.lease_type) || null,
    lease_start: approvedFieldValue(lease, ["commencement_date", "start_date"]) || lease.commencement_date || "",
    rent_commencement_date: approvedFieldValue(lease, ["rent_commencement_date"]) || "",
    lease_end: approvedFieldValue(lease, ["expiration_date", "end_date"]) || lease.expiration_date || "",
    monthly_rent: monthlyRent,
    annualized_rent: annualizedRent,
    rsf,
    rent_psf: rsf > 0 && annualizedRent > 0 ? annualizedRent / rsf : null,
  };
}

function moneyDelta(current, comparison) {
  const delta = Number(current || 0) - Number(comparison || 0);
  if (!delta) return "$0";
  return `${delta > 0 ? "+" : "-"}${fmtMoney(Math.abs(delta))}`;
}

function pctDelta(current, comparison) {
  const base = Number(comparison || 0);
  if (!base) return Number(current || 0) ? "new" : "-";
  const pct = ((Number(current || 0) - base) / base) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function yyyyMmDd(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

export default function LeaseRentSchedule() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const leaseId = params.get("id") || params.get("lease_id");
  const initialYear = Number(params.get("fiscal_year")) || new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(initialYear);

  const { data: leases = [], isLoading: leasesLoading } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const lease = useMemo(() => leases.find((item) => item.id === leaseId) || null, [leases, leaseId]);
  const propertyById = useMemo(() => new Map(properties.map((item) => [item.id, item])), [properties]);
  const buildingById = useMemo(() => new Map(buildings.map((item) => [item.id, item])), [buildings]);
  const unitById = useMemo(() => new Map(units.map((item) => [item.id, item])), [units]);
  const leaseRow = useMemo(() => buildLeaseProjectionRow(lease), [lease]);

  useAssistantPageContext({
    page: "LeaseRentSchedule",
    entities: { leaseId: leaseId || undefined, propertyId: lease?.property_id || undefined },
    fiscalYear,
  });

  const { data: rentScheduleRows = [], isLoading: schedulesLoading, refetch } = useQuery({
    queryKey: ["lease-rent-schedule", leaseId],
    enabled: !!leaseId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rent_schedules")
        .select("*")
        .eq("lease_id", leaseId)
        .order("period_start", { ascending: true });
      if (error) {
        if (/does not exist|rent_schedules/i.test(error?.message || "")) return [];
        throw error;
      }
      return data || [];
    },
    retry: false,
  });

  const persistedRows = useMemo(() => scheduleRowsForLease(rentScheduleRows, leaseId), [rentScheduleRows, leaseId]);
  const fiscalYearOptions = useMemo(() => buildRentFiscalYearOptions({
    selectedYear: fiscalYear,
    currentYear: new Date().getFullYear(),
    leaseRows: leaseRow ? [leaseRow] : [],
    scheduleRows: persistedRows,
  }), [fiscalYear, leaseRow, persistedRows]);

  const periods = useMemo(() => {
    if (!leaseRow || schedulesLoading) return [];
    return [fiscalYear - 1, fiscalYear, fiscalYear + 1].map((year) =>
      buildLeaseYearSchedule(leaseRow, persistedRows, year),
    );
  }, [leaseRow, persistedRows, fiscalYear, schedulesLoading]);

  const rentBearingYears = useMemo(() => {
    if (!leaseRow || schedulesLoading) return [];
    return fiscalYearOptions.filter((year) =>
      buildLeaseYearSchedule(leaseRow, persistedRows, year).total > 0,
    );
  }, [fiscalYearOptions, leaseRow, persistedRows, schedulesLoading]);

  const selectedYearHasNoRent = periods.length === 3 && periods[1].total === 0 && rentBearingYears.length > 0;
  const suggestedRentYear = rentBearingYears[rentBearingYears.length - 1] || null;

  const comparisonRows = useMemo(() => {
    if (periods.length !== 3) return [];
    return RENT_SCHEDULE_MONTHS.map((month, index) => {
      const previous = periods[0].months[index].amount;
      const current = periods[1].months[index].amount;
      const next = periods[2].months[index].amount;
      return {
        month,
        previous,
        current,
        next,
        currentVariance: moneyDelta(current, previous),
        currentVariancePct: pctDelta(current, previous),
        nextVariance: moneyDelta(next, current),
        nextVariancePct: pctDelta(next, current),
      };
    });
  }, [periods]);

  const property = leaseRow?.property_id ? propertyById.get(leaseRow.property_id) : null;
  const unit = leaseRow?.unit_id ? unitById.get(leaseRow.unit_id) : null;
  const building = leaseRow?.building_id
    ? buildingById.get(leaseRow.building_id)
    : (unit?.building_id ? buildingById.get(unit.building_id) : null);
  const sourceLabel = schedulesLoading
    ? "Loading schedule rows"
    : (persistedRows.length > 0 ? "Stored schedule rows" : "Approved abstract preview");

  const handleExport = () => {
    if (!comparisonRows.length) return;
    downloadCSV(
      comparisonRows.map((row) => ({
        month: row.month,
        [`fy_${fiscalYear - 1}`]: row.previous,
        [`fy_${fiscalYear}`]: row.current,
        [`fy_${fiscalYear}_vs_${fiscalYear - 1}`]: row.currentVariance,
        [`fy_${fiscalYear}_variance_pct`]: row.currentVariancePct,
        [`fy_${fiscalYear + 1}`]: row.next,
        [`fy_${fiscalYear + 1}_vs_${fiscalYear}`]: row.nextVariance,
        [`fy_${fiscalYear + 1}_variance_pct`]: row.nextVariancePct,
        source: sourceLabel,
      })),
      `lease-rent-schedule-${leaseId || "lease"}-${fiscalYear}.csv`,
    );
  };

  if (!leaseId) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-slate-500">Select a lease from Rent Projection to view its schedule.</p>
            <Button asChild className="mt-4">
              <Link to={createPageUrl("RentProjection")}>Back to Rent Projection</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-[1500px] mx-auto">
      <PageHeader
        icon={FileSpreadsheet}
        title="Lease Rent Schedule"
        subtitle={leaseRow ? `${leaseRow.tenant_name} - ${property?.name || "No property"}` : "Monthly rent comparison"}
        iconColor="from-blue-700 to-blue-600"
      >
        <Button asChild variant="outline" size="sm">
          <Link to={createPageUrl("RentProjection")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Rent Projection
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={createPageUrl("LeaseDetail", { id: leaseId })}>Open Lease Detail</Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={schedulesLoading}>
          <RefreshCw className={`h-4 w-4 ${schedulesLoading ? "animate-spin" : ""}`} />
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!comparisonRows.length}>
          <Download className="h-4 w-4 mr-1" />
          Export CSV
        </Button>
        <Select value={String(fiscalYear)} onValueChange={(value) => setFiscalYear(Number(value))}>
          <SelectTrigger className="h-8 w-32">
            <CalendarDays className="h-3.5 w-3.5 mr-1 text-slate-400" />
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
      </PageHeader>

      {leasesLoading ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Loader2 className="h-5 w-5 animate-spin mx-auto text-slate-400" />
          </CardContent>
        </Card>
      ) : !leaseRow ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">Lease not found.</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Lease Type</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {getLeaseFieldLabel("lease_type", leaseRow.lease_type) || leaseRow.lease_type || "-"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Property / Building</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{property?.name || "-"}</p>
                <p className="text-xs text-slate-500">{building?.name || "-"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Unit / RSF</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{unit?.unit_number || "-"}</p>
                <p className="text-xs text-slate-500">{Number(leaseRow.rsf || 0).toLocaleString()} RSF</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Term</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{leaseRow.lease_start || "-"} to {leaseRow.lease_end || "-"}</p>
                <p className="text-xs text-slate-500">Rent start {leaseRow.rent_commencement_date || leaseRow.lease_start || "-"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Monthly / Annual</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{fmtMoney(leaseRow.monthly_rent)}</p>
                <p className="text-xs text-slate-500">{fmtMoney(leaseRow.annualized_rent)} annualized</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Schedule Source</p>
                <Badge variant="outline" className="mt-1 text-[10px]">{sourceLabel}</Badge>
                <p className="mt-1 text-xs text-slate-500">{persistedRows.length} stored row(s)</p>
              </CardContent>
            </Card>
          </div>

          {selectedYearHasNoRent && (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-3 text-sm text-amber-800">
                  <AlertCircle className="h-5 w-5 shrink-0 text-amber-500" />
                  <div>
                    <p className="font-semibold">FY{fiscalYear} is outside this lease rent schedule.</p>
                    <p className="text-xs text-amber-700">
                      The lease rent term runs {leaseRow.rent_commencement_date || leaseRow.lease_start || "-"} to {leaseRow.lease_end || "-"}. Select FY{suggestedRentYear} to view the last year with scheduled rent.
                    </p>
                  </div>
                </div>
                {suggestedRentYear && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setFiscalYear(suggestedRentYear)}>
                    View FY{suggestedRentYear}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Monthly Rent Comparison</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[11px] uppercase text-slate-500">Month</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">FY{fiscalYear - 1}</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">FY{fiscalYear}</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">FY{fiscalYear} vs FY{fiscalYear - 1}</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">Variance %</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">FY{fiscalYear + 1}</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">FY{fiscalYear + 1} vs FY{fiscalYear}</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">Variance %</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedulesLoading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center">
                        <Loader2 className="h-5 w-5 animate-spin mx-auto text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ) : comparisonRows.map((row) => (
                    <TableRow key={row.month}>
                      <TableCell className="text-sm font-semibold text-slate-900">{row.month}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtMoney(row.previous)}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">{fmtMoney(row.current)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.currentVariance}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.currentVariancePct}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtMoney(row.next)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.nextVariance}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.nextVariancePct}</TableCell>
                      <TableCell className="text-xs text-slate-500">{sourceLabel}</TableCell>
                    </TableRow>
                  ))}
                  {periods.length === 3 && (
                    <TableRow className="bg-slate-50 font-semibold">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(periods[0].total)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(periods[1].total)}</TableCell>
                      <TableCell className="text-right font-mono">{moneyDelta(periods[1].total, periods[0].total)}</TableCell>
                      <TableCell className="text-right font-mono">{pctDelta(periods[1].total, periods[0].total)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(periods[2].total)}</TableCell>
                      <TableCell className="text-right font-mono">{moneyDelta(periods[2].total, periods[1].total)}</TableCell>
                      <TableCell className="text-right font-mono">{pctDelta(periods[2].total, periods[1].total)}</TableCell>
                      <TableCell className="text-xs text-slate-500">{sourceLabel}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-blue-500" />
                Stored Schedule Rows
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[11px] uppercase text-slate-500">Period Start</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500">Period End</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">Monthly Amount</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">Annual Amount</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500 text-right">Rent / SF</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500">Source</TableHead>
                    <TableHead className="text-[11px] uppercase text-slate-500">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedulesLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center">
                        <Loader2 className="h-5 w-5 animate-spin mx-auto text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ) : persistedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-sm text-slate-400">
                        No stored schedule rows. The comparison is using approved abstract rent fields.
                      </TableCell>
                    </TableRow>
                  ) : (
                    persistedRows.map((row) => (
                      <TableRow key={row.id || `${row.period_start}-${row.period_end}`}>
                        <TableCell className="text-sm">{yyyyMmDd(row.period_start)}</TableCell>
                        <TableCell className="text-sm">{yyyyMmDd(row.period_end)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtMoney(row.monthly_amount)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtMoney(row.annual_amount)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row.rent_per_sf == null ? "-" : `$${Number(row.rent_per_sf).toFixed(2)}`}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">{row.source || row.provenance || "-"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{row.status || "stored"}</Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
