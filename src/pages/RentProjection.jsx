import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Loader2, RefreshCw, AlertCircle } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { toast } from "sonner";
import { propertyService } from "@/services/propertyService";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL_PROPERTIES = "__all__";

export default function RentProjection() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const initProperty = urlParams.get("property") || ALL_PROPERTIES;
  const [selectedProperty, setSelectedProperty] = useState(initProperty);
  const currentYear = new Date().getFullYear();
  const selectedPropertyId = selectedProperty === ALL_PROPERTIES ? null : selectedProperty;

  const { data: properties = [] } = useQuery({
    queryKey: ["properties-rent"],
    queryFn: () => propertyService.list(),
  });

  const { snapshot, outputs, isLoading, isFetching, refetch } = useSnapshotQuery({
    engineType: "lease",
    propertyId: selectedPropertyId,
    fiscalYear: currentYear,
  });

  const { trigger: triggerCompute, isTriggering } = useComputeTrigger();

  const tenantRentData = outputs?.tenant_schedules ?? [];
  const summary = outputs?.summary ?? {};
  const monthlyProjections = outputs?.monthly_projections ?? [];

  const monthlyChart = MONTHS.map((month, index) => {
    const projection = monthlyProjections.find((item) => item.month === index + 1) ?? {};

    return {
      month,
      current: Math.round(projection.base_rent ?? 0),
      projected: Math.round(projection.projected_rent ?? 0),
      previous: Math.round(projection.previous_rent ?? 0),
      budget: Math.round(projection.budget_rent ?? 0),
    };
  });

  const totalCurrentMonthly = summary.avg_monthly_rent ?? 0;
  const totalProjectedMonthly = summary.avg_projected_monthly ?? 0;
  const totalPrevMonthly = summary.avg_previous_monthly ?? 0;
  const totalCurrentAnnual = summary.total_rent ?? 0;
  const totalProjectedAnnual = summary.total_projected_rent ?? 0;
  const yoyChange =
    totalPrevMonthly > 0
      ? ((totalCurrentMonthly - totalPrevMonthly) / totalPrevMonthly * 100).toFixed(1)
      : null;

  const handleTriggerCompute = async () => {
    if (!selectedProperty) {
      toast.error("Select a property first");
      return;
    }
    if (!selectedPropertyId) {
      toast.error("Select a property first");
      return;
    }

    try {
      await triggerCompute(
        "compute-lease",
        {
          property_id: selectedPropertyId,
          fiscal_year: currentYear,
        },
        {
          successMessage: "Computation started — results will appear shortly",
        }
      );
      setTimeout(() => refetch(), 3000);
    } catch {
      toast.error("Failed to trigger computation");
    }
  };

  const noSnapshot = !isLoading && !snapshot;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rent Roll & Projection</h1>
          <p className="text-sm text-slate-500 mt-1">
            Computed rent schedules, escalations, and projections
            {snapshot && (
              <span className="ml-2 text-slate-400">
                {" · "}Last computed {new Date(snapshot.computed_at).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedProperty} onValueChange={setSelectedProperty}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="All Properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROPERTIES}>All Properties</SelectItem>
              {properties.map((property) => (
                <SelectItem key={property.id} value={property.id}>
                  {property.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            Run Computation
          </Button>
        </div>
      </div>

      {noSnapshot && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-6 flex items-center gap-4">
            <AlertCircle className="w-8 h-8 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-800">No computation results yet</p>
              <p className="text-xs text-amber-600 mt-1">
                Select a property and click "Run Computation" to generate rent schedules. Results are
                automatically computed after uploading lease data.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
          <span className="ml-3 text-slate-500">Loading computation results...</span>
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="border-l-4 border-l-blue-500">
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold text-slate-500 uppercase">Current Monthly Rent</p>
                <p className="text-2xl font-bold text-slate-900">
                  ${totalCurrentMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-slate-400">
                  ${totalCurrentAnnual.toLocaleString(undefined, { maximumFractionDigits: 0 })} annual
                </p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-emerald-500">
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold text-slate-500 uppercase">
                  Projected Monthly (Next Yr)
                </p>
                <p className="text-2xl font-bold text-emerald-600">
                  ${totalProjectedMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-emerald-500">
                  ${totalProjectedAnnual.toLocaleString(undefined, { maximumFractionDigits: 0 })} annual
                </p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-slate-400">
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold text-slate-500 uppercase">Previous Monthly Rent</p>
                <p className="text-2xl font-bold text-slate-500">
                  ${totalPrevMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-slate-400">From historical leases</p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-amber-500">
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold text-slate-500 uppercase">YoY Change</p>
                <p className="text-2xl font-bold">
                  {yoyChange !== null ? (
                    <span className={parseFloat(yoyChange) >= 0 ? "text-emerald-600" : "text-red-500"}>
                      {parseFloat(yoyChange) >= 0 ? "+" : ""}
                      {yoyChange}%
                    </span>
                  ) : (
                    "—"
                  )}
                </p>
                <p className="text-[10px] text-slate-400">Current vs Previous</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Monthly Rent — Current vs Projected vs Previous vs Budget
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyChart}>
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                  <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
                  <Legend />
                  <Bar dataKey="current" name="Current Rent" fill="#1a2744" radius={[2, 2, 0, 0]} barSize={18} />
                  <Bar
                    dataKey="projected"
                    name="Projected (Next Yr)"
                    fill="#10b981"
                    radius={[2, 2, 0, 0]}
                    barSize={18}
                  />
                  <Bar dataKey="previous" name="Previous Rent" fill="#94a3b8" radius={[2, 2, 0, 0]} barSize={18} />
                  <Bar dataKey="budget" name="Budget Revenue" fill="#3b82f6" radius={[2, 2, 0, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tenant Rent Summary</CardTitle>
            </CardHeader>
            <CardContent>
              {tenantRentData.length === 0 ? (
                <p className="text-center py-8 text-sm text-slate-400">No tenant data in snapshot</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="text-[11px]">TENANT</TableHead>
                      <TableHead className="text-[11px]">TYPE</TableHead>
                      <TableHead className="text-[11px] text-right">SF</TableHead>
                      <TableHead className="text-[11px] text-right">RENT/SF</TableHead>
                      <TableHead className="text-[11px] text-right">BASE RENT/MO</TableHead>
                      <TableHead className="text-[11px] text-right">CAM/MO</TableHead>
                      <TableHead className="text-[11px] text-right">TOTAL/MO</TableHead>
                      <TableHead className="text-[11px] text-right">PROJECTED/MO</TableHead>
                      <TableHead className="text-[11px]">ESCALATION</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenantRentData.map((tenant, index) => (
                      <TableRow key={index}>
                        <TableCell className="text-sm font-medium">{tenant.tenant_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {tenant.lease_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          {(tenant.square_footage || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(tenant.rent_per_sf || 0).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(tenant.monthly_rent || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(tenant.cam_charge || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right font-bold">
                          ${(tenant.total_rent || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right text-emerald-600">
                          ${(tenant.projected_monthly || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {tenant.escalation_type || "none"}
                            {tenant.escalation_rate > 0 ? ` ${tenant.escalation_rate}%` : ""}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {outputs?.rent_schedule && outputs.rent_schedule.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monthly Rent Schedule — Jan to Dec {currentYear}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="text-[11px] sticky left-0 bg-slate-50 z-10">MONTH</TableHead>
                      <TableHead className="text-[11px] text-right">BASE RENT</TableHead>
                      <TableHead className="text-[11px] text-right">ESCALATED RENT</TableHead>
                      <TableHead className="text-[11px] text-right">CAM CHARGE</TableHead>
                      <TableHead className="text-[11px] text-right font-bold">TOTAL RENT</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outputs.rent_schedule.map((row, index) => (
                      <TableRow key={index}>
                        <TableCell className="text-sm sticky left-0 bg-white z-10">{row.month}</TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(row.base_rent || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(row.escalated_rent || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          ${(row.cam_charge || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right font-bold text-blue-600">
                          ${(row.total_rent || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
