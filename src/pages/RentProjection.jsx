import React, { useState, useMemo } from "react";
import { budgetService } from "@/services/budgetService";
import { leaseService } from "@/services/leaseService";
import { propertyService } from "@/services/propertyService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function RentProjection() {
  const urlParams = new URLSearchParams(window.location.search);
  const initProperty = urlParams.get("property") || "";
  const [selectedProperty, setSelectedProperty] = useState(initProperty);
  const currentYear = new Date().getFullYear();

  const { data: properties = [] } = useQuery({
    queryKey: ['properties-rent'],
    queryFn: () => propertyService.list(),
  });

  const { data: leases = [], isLoading: leasesLoading } = useQuery({
    queryKey: ['leases-rent', selectedProperty],
    queryFn: () => selectedProperty 
      ? leaseService.filter({ property_id: selectedProperty })
      : leaseService.list(),
  });

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-rent', selectedProperty],
    queryFn: () => selectedProperty
      ? budgetService.filter({ property_id: selectedProperty })
      : budgetService.list(),
  });

  // Separate active vs expired/historical leases
  const activeLeases = leases.filter(l => l.status !== 'expired');
  const historicalLeases = leases.filter(l => l.status === 'expired');

  // Calculate monthly rent per tenant
  const tenantRentData = useMemo(() => {
    return activeLeases.map(lease => {
      const monthlyBase = (lease.annual_rent || 0) / 12;
      const monthlyCAM = lease.cam_per_month || 0;
      const totalMonthly = monthlyBase + monthlyCAM;

      // Find historical lease for same tenant
      const prevLease = historicalLeases.find(h => h.tenant_name === lease.tenant_name);
      const prevMonthlyBase = prevLease ? (prevLease.annual_rent || 0) / 12 : 0;
      const prevMonthlyCAM = prevLease ? (prevLease.cam_per_month || 0) : 0;
      const prevTotal = prevMonthlyBase + prevMonthlyCAM;

      // Projected rent with escalation
      let projectedMonthly = monthlyBase;
      if (lease.escalation_type === 'fixed' || lease.escalation_type === 'percentage') {
        projectedMonthly = monthlyBase * (1 + (lease.escalation_rate || 0) / 100);
      } else if (lease.escalation_type === 'cpi') {
        projectedMonthly = monthlyBase * 1.03; // Assume 3% CPI
      }

      return {
        tenant: lease.tenant_name,
        unit: lease.unit_id,
        leaseType: lease.lease_type,
        sf: lease.total_sf || 0,
        rentPerSF: lease.rent_per_sf || 0,
        monthlyBase,
        monthlyCAM,
        totalMonthly,
        prevMonthlyBase,
        prevMonthlyCAM,
        prevTotal,
        projectedMonthly: projectedMonthly + monthlyCAM,
        escalationType: lease.escalation_type || 'none',
        escalationRate: lease.escalation_rate || 0,
        startDate: lease.start_date,
        endDate: lease.end_date,
        change: prevTotal > 0 ? ((totalMonthly - prevTotal) / prevTotal * 100).toFixed(1) : null,
      };
    });
  }, [activeLeases, historicalLeases]);

  // Monthly projection chart data
  const monthlyChart = useMemo(() => {
    return MONTHS.map((month, i) => {
      let currentRent = 0;
      let projectedRent = 0;
      let prevRent = 0;

      tenantRentData.forEach(t => {
        currentRent += t.totalMonthly;
        projectedRent += t.projectedMonthly;
        prevRent += t.prevTotal;
      });

      // Budget revenue if available
      const currentBudget = budgets.find(b => b.budget_year === currentYear);
      const budgetMonthly = currentBudget ? (currentBudget.total_revenue || 0) / 12 : 0;

      return {
        month,
        current: Math.round(currentRent),
        projected: Math.round(projectedRent),
        previous: Math.round(prevRent),
        budget: Math.round(budgetMonthly),
      };
    });
  }, [tenantRentData, budgets, currentYear]);

  const totalCurrentMonthly = tenantRentData.reduce((s, t) => s + t.totalMonthly, 0);
  const totalProjectedMonthly = tenantRentData.reduce((s, t) => s + t.projectedMonthly, 0);
  const totalPrevMonthly = tenantRentData.reduce((s, t) => s + t.prevTotal, 0);
  const totalCurrentAnnual = totalCurrentMonthly * 12;
  const totalProjectedAnnual = totalProjectedMonthly * 12;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rent Roll & Projection</h1>
          <p className="text-sm text-slate-500 mt-1">Monthly rent calculation, projected vs previous rent from historical leases & budgets</p>
        </div>
        <Select value={selectedProperty} onValueChange={setSelectedProperty}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All Properties" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={null}>All Properties</SelectItem>
            {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Current Monthly Rent</p>
            <p className="text-2xl font-bold text-slate-900">${totalCurrentMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            <p className="text-[10px] text-slate-400">${totalCurrentAnnual.toLocaleString(undefined, { maximumFractionDigits: 0 })} annual</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Projected Monthly (Next Yr)</p>
            <p className="text-2xl font-bold text-emerald-600">${totalProjectedMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            <p className="text-[10px] text-emerald-500">${totalProjectedAnnual.toLocaleString(undefined, { maximumFractionDigits: 0 })} annual</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-400">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Previous Monthly Rent</p>
            <p className="text-2xl font-bold text-slate-500">${totalPrevMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            <p className="text-[10px] text-slate-400">From historical leases</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">YoY Change</p>
            <p className="text-2xl font-bold">
              {totalPrevMonthly > 0 ? (
                <span className={(totalCurrentMonthly - totalPrevMonthly) >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                  {((totalCurrentMonthly - totalPrevMonthly) / totalPrevMonthly * 100).toFixed(1)}%
                </span>
              ) : '—'}
            </p>
            <p className="text-[10px] text-slate-400">Current vs Previous</p>
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <CardHeader><CardTitle className="text-base">Monthly Rent — Current vs Projected vs Previous vs Budget</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyChart}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend />
              <Bar dataKey="current" name="Current Rent" fill="#1a2744" radius={[2, 2, 0, 0]} barSize={18} />
              <Bar dataKey="projected" name="Projected (Next Yr)" fill="#10b981" radius={[2, 2, 0, 0]} barSize={18} />
              <Bar dataKey="previous" name="Previous Rent" fill="#94a3b8" radius={[2, 2, 0, 0]} barSize={18} />
              <Bar dataKey="budget" name="Budget Revenue" fill="#3b82f6" radius={[2, 2, 0, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Per-tenant summary */}
      <Card>
        <CardHeader><CardTitle className="text-base">Tenant Rent Summary</CardTitle></CardHeader>
        <CardContent>
          {leasesLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
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
                  <TableHead className="text-[11px] text-right">PREV TOTAL/MO</TableHead>
                  <TableHead className="text-[11px] text-right">PROJECTED/MO</TableHead>
                  <TableHead className="text-[11px]">ESCALATION</TableHead>
                  <TableHead className="text-[11px] text-right">CHANGE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantRentData.length > 0 ? tenantRentData.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm font-medium">{t.tenant}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{t.leaseType}</Badge></TableCell>
                    <TableCell className="text-sm font-mono text-right">{t.sf.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${t.rentPerSF.toFixed(2)}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${t.monthlyBase.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${t.monthlyCAM.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right font-bold">${t.totalMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-slate-400">${t.prevTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-emerald-600">${t.projectedMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {t.escalationType}{t.escalationRate > 0 ? ` ${t.escalationRate}%` : ''}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {t.change !== null ? (
                        <span className={`text-xs font-medium ${parseFloat(t.change) >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                          {parseFloat(t.change) >= 0 ? '+' : ''}{t.change}%
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={11} className="text-center py-8 text-sm text-slate-400">No lease data available</TableCell></TableRow>
                )}
                {tenantRentData.length > 0 && (
                  <TableRow className="bg-slate-50 font-bold">
                    <TableCell className="text-sm">TOTAL</TableCell>
                    <TableCell />
                    <TableCell className="text-sm font-mono text-right">{tenantRentData.reduce((s, t) => s + t.sf, 0).toLocaleString()}</TableCell>
                    <TableCell />
                    <TableCell className="text-sm font-mono text-right">${tenantRentData.reduce((s, t) => s + t.monthlyBase, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${tenantRentData.reduce((s, t) => s + t.monthlyCAM, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${totalCurrentMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-slate-400">${totalPrevMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-emerald-600">${totalProjectedMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Jan-Dec Monthly Rent Schedule */}
      <Card>
        <CardHeader><CardTitle className="text-base">Monthly Rent Schedule — Jan to Dec {currentYear}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {tenantRentData.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px] sticky left-0 bg-slate-50 z-10">TENANT</TableHead>
                  {MONTHS.map(m => <TableHead key={m} className="text-[11px] text-right min-w-[80px]">{m}</TableHead>)}
                  <TableHead className="text-[11px] text-right font-bold min-w-[90px]">ANNUAL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantRentData.map((t, i) => {
                  const startDate = t.startDate ? new Date(t.startDate) : null;
                  const endDate = t.endDate ? new Date(t.endDate) : null;
                  return (
                    <TableRow key={i}>
                      <TableCell className="text-sm font-medium sticky left-0 bg-white z-10">{t.tenant}</TableCell>
                      {MONTHS.map((m, mi) => {
                        const monthDate = new Date(currentYear, mi, 15);
                        const isActive = (!startDate || monthDate >= startDate) && (!endDate || monthDate <= endDate);
                        const rent = isActive ? t.totalMonthly : 0;
                        return (
                          <TableCell key={m} className={`text-xs font-mono text-right ${isActive ? 'text-slate-700' : 'text-slate-300'}`}>
                            {isActive ? `$${rent.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-xs font-mono text-right font-bold text-blue-600">
                        ${(MONTHS.reduce((sum, m, mi) => {
                          const monthDate = new Date(currentYear, mi, 15);
                          const isActive = (!startDate || monthDate >= startDate) && (!endDate || monthDate <= endDate);
                          return sum + (isActive ? t.totalMonthly : 0);
                        }, 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-slate-50 font-bold">
                  <TableCell className="text-sm sticky left-0 bg-slate-50 z-10">TOTAL</TableCell>
                  {MONTHS.map((m, mi) => {
                    const monthTotal = tenantRentData.reduce((sum, t) => {
                      const startDate = t.startDate ? new Date(t.startDate) : null;
                      const endDate = t.endDate ? new Date(t.endDate) : null;
                      const monthDate = new Date(currentYear, mi, 15);
                      const isActive = (!startDate || monthDate >= startDate) && (!endDate || monthDate <= endDate);
                      return sum + (isActive ? t.totalMonthly : 0);
                    }, 0);
                    return <TableCell key={m} className="text-xs font-mono text-right font-bold">${monthTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>;
                  })}
                  <TableCell className="text-xs font-mono text-right font-bold text-blue-600">
                    ${tenantRentData.reduce((sum, t) => {
                      const startDate = t.startDate ? new Date(t.startDate) : null;
                      const endDate = t.endDate ? new Date(t.endDate) : null;
                      return sum + MONTHS.reduce((mSum, m, mi) => {
                        const monthDate = new Date(currentYear, mi, 15);
                        const isActive = (!startDate || monthDate >= startDate) && (!endDate || monthDate <= endDate);
                        return mSum + (isActive ? t.totalMonthly : 0);
                      }, 0);
                    }, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          ) : (
            <p className="text-center py-8 text-sm text-slate-400">No lease data available</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}