import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  MapPin, Home, Upload, DollarSign, Calculator, ClipboardCheck, Pencil, Plus, Loader2, AlertTriangle, CheckCircle2, BarChart2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

import { PropertyService, LeaseService, ExpenseService, UnitService, BuildingService, StakeholderService } from "@/services/api";
import { createPageUrl } from "@/utils";

import PropertyExpensesTab from "@/components/property/PropertyExpensesTab";
import PropertyCAMTab from "@/components/property/PropertyCAMTab";
import PropertyBudgetsTab from "@/components/property/PropertyBudgetsTab";

export default function PropertyDetail() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const propertyId = urlParams.get("id");
  const queryClient = useQueryClient();

  const [showAddBuilding, setShowAddBuilding] = useState(false);
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [selectedBuildingId, setSelectedBuildingId] = useState(null);
  const [buildingForm, setBuildingForm] = useState({ name: "", total_sqft: "", floors: 1 });
  const [unitForm, setUnitForm] = useState({ unit_number: "", square_footage: "", status: "vacant" });

  const { data: property, isLoading } = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => PropertyService.filter({ id: propertyId }),
    enabled: !!propertyId,
    select: data => data?.[0],
  });

  const { data: units = [] } = useQuery({
    queryKey: ['units', propertyId],
    queryFn: () => UnitService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: buildings = [] } = useQuery({
    queryKey: ['buildings', propertyId],
    queryFn: () => BuildingService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: leases = [] } = useQuery({
    queryKey: ['leases-prop', propertyId],
    queryFn: () => LeaseService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: stakeholders = [] } = useQuery({
    queryKey: ['stakeholders-prop', propertyId],
    queryFn: () => StakeholderService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses-prop', propertyId],
    queryFn: () => ExpenseService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const createBuildingMutation = useMutation({
    mutationFn: (data) => BuildingService.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['buildings', propertyId] }); setShowAddBuilding(false); setBuildingForm({ name: "", total_sqft: "", floors: 1 }); }
  });

  const createUnitMutation = useMutation({
    mutationFn: (data) => UnitService.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['units', propertyId] }); setShowAddUnit(false); setUnitForm({ unit_number: "", square_footage: "", status: "vacant" }); }
  });

  if (isLoading) return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  if (!property) return <div className="p-6 text-center text-slate-400">Property not found</div>;

  const leasedUnits = units.filter(u => u.status === 'leased');
  const vacantUnits = units.filter(u => u.status === 'vacant');
  const preLeaseUnits = units.filter(u => u.status === 'pre_lease');
  const ownerOccUnits = units.filter(u => u.status === 'owner_occupied');
  const underConstUnits = units.filter(u => u.status === 'under_construction');
  const leasedSF = leasedUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
  const totalSF = units.reduce((s, u) => s + (u.square_footage || 0), 0) || property.total_sqft || 0;
  const vacantSF = vacantUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
  const preLeasesSF = preLeaseUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
  const ownerOccSF = ownerOccUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
  const underConstSF = underConstUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
  const camEligibleSF = totalSF - underConstSF;
  const occupancyPct = totalSF > 0 ? ((leasedSF / totalSF) * 100).toFixed(1) : 0;

  const statusColors = {
    leased: "bg-emerald-100 text-emerald-700", vacant: "bg-red-100 text-red-700",
    owner_occupied: "bg-blue-100 text-blue-700", under_construction: "bg-slate-100 text-slate-700",
    pre_lease: "bg-amber-100 text-amber-700"
  };

  const leaseStatusColors = {
    draft: "bg-slate-100 text-slate-600", extracted: "bg-blue-100 text-blue-700",
    validated: "bg-amber-100 text-amber-700", budget_ready: "bg-emerald-100 text-emerald-700",
    expired: "bg-red-100 text-red-700", none: "bg-slate-100 text-slate-400"
  };

  return (
    <div className="p-6 space-y-6">
      {/* Property Header */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center"><Home className="w-6 h-6 text-slate-500" /></div>
                <div>
                  <h1 className="text-2xl font-bold text-slate-900">{property.name}</h1>
                  <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                    <MapPin className="w-3.5 h-3.5" />
                    {property.address}{property.city ? `, ${property.city}` : ''}{property.state ? `, ${property.state} ${property.zip || ''}` : ''}
                    <Badge variant="outline" className="capitalize">{property.property_type?.replace('_', ' ')}</Badge>
                    <span className="text-slate-400">ID: {property.property_id_code || property.id?.substring(0, 8)}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-6 md:gap-8 mt-4 flex-wrap">
                <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Total SF</p><p className="text-lg font-bold">{totalSF.toLocaleString()}</p></div>
                <div><p className="text-[10px] font-semibold text-emerald-600 uppercase">Occupancy</p><p className="text-lg font-bold text-emerald-600">{occupancyPct}%</p></div>
                <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Buildings</p><p className="text-lg font-bold">{buildings.length || property.total_buildings || 1}</p></div>
                <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Units</p><p className="text-lg font-bold">{units.length}</p></div>
                <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Leased SF</p><p className="text-lg font-bold">{leasedSF.toLocaleString()}</p></div>
                <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Vacant SF</p><p className="text-lg font-bold">{vacantSF.toLocaleString()}</p></div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm"><Pencil className="w-4 h-4 mr-1" />Edit Property</Button>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => { setSelectedBuildingId(buildings[0]?.id || null); setShowAddUnit(true); }}><Plus className="w-4 h-4 mr-1" />Add Unit</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList className="bg-white border">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="buildings">Buildings & Units</TabsTrigger>
          <TabsTrigger value="leases">Leases</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          <TabsTrigger value="cam">CAM</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="stakeholders">Stakeholders</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">Occupancy Breakdown</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-5 gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-xs text-slate-500">Leased</span></div>
                    <p className="text-2xl font-bold text-slate-900">{totalSF > 0 ? ((leasedSF / totalSF) * 100).toFixed(0) : 0}%</p>
                    <p className="text-xs text-slate-400">{leasedUnits.length} units · {leasedSF.toLocaleString()} SF</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs text-slate-500">Vacant</span></div>
                    <p className="text-2xl font-bold text-slate-900">{totalSF > 0 ? ((vacantSF / totalSF) * 100).toFixed(0) : 0}%</p>
                    <p className="text-xs text-slate-400">{vacantUnits.length} units · {vacantSF.toLocaleString()} SF</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full bg-amber-500" /><span className="text-xs text-slate-500">Pre-Lease</span></div>
                    <p className="text-2xl font-bold text-slate-900">{totalSF > 0 ? ((preLeasesSF / totalSF) * 100).toFixed(0) : 0}%</p>
                    <p className="text-xs text-slate-400">{preLeaseUnits.length} units · {preLeasesSF.toLocaleString()} SF</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-xs text-slate-500">Owner Occ.</span></div>
                    <p className="text-2xl font-bold text-slate-900">{totalSF > 0 ? ((ownerOccSF / totalSF) * 100).toFixed(0) : 0}%</p>
                    <p className="text-xs text-slate-400">{ownerOccUnits.length} units · Rev=0</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full bg-slate-400" /><span className="text-xs text-slate-500">Under Const.</span></div>
                    <p className="text-2xl font-bold text-slate-900">{totalSF > 0 ? ((underConstSF / totalSF) * 100).toFixed(0) : 0}%</p>
                    <p className="text-xs text-slate-400">{underConstUnits.length} units · Excl. CAM</p>
                  </div>
                </div>
                <div className="mt-4 h-3 rounded-full overflow-hidden flex bg-slate-100">
                  <div className="bg-emerald-500 h-full" style={{ width: `${totalSF > 0 ? (leasedSF / totalSF * 100) : 0}%` }} />
                  <div className="bg-red-400 h-full" style={{ width: `${totalSF > 0 ? (vacantSF / totalSF * 100) : 0}%` }} />
                  <div className="bg-amber-400 h-full" style={{ width: `${totalSF > 0 ? (preLeasesSF / totalSF * 100) : 0}%` }} />
                  <div className="bg-blue-400 h-full" style={{ width: `${totalSF > 0 ? (ownerOccSF / totalSF * 100) : 0}%` }} />
                  <div className="bg-slate-400 h-full" style={{ width: `${totalSF > 0 ? (underConstSF / totalSF * 100) : 0}%` }} />
                </div>
              </CardContent>
            </Card>

            <Card className="border-blue-100 shadow-sm">
              <CardHeader className="pb-3 border-b border-slate-50 bg-slate-50/50 rounded-t-xl">
                <CardTitle className="text-base font-bold text-slate-800 flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-600"><ClipboardCheck className="w-3.5 h-3.5" /></div>
                  Property Control Center
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div className="space-y-1.5">
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Core Actions</p>
                  {[
                    { icon: Upload, label: "Upload Lease Agreement", page: "LeaseUpload", desc: "Extract & validate AI" },
                    { icon: DollarSign, label: "Add Operating Expense", page: "AddExpense", desc: "Log a new property bill" },
                    { icon: Calculator, label: "Run CAM Calculation", page: "CAMDashboard", desc: "Reconcile common area" },
                    { icon: ClipboardCheck, label: "Generate Property Budget", page: "CreateBudget", desc: "Create annual forecast" },
                  ].map((a, i) => (
                    <Link key={i} to={createPageUrl(a.page) + `?property=${propertyId}`} className="block">
                      <Button variant="ghost" className="w-full justify-start h-auto py-2 px-3 gap-3 text-left hover:bg-slate-50 group border border-transparent hover:border-slate-100">
                        <div className="w-8 h-8 rounded-lg bg-slate-100 group-hover:bg-white flex flex-shrink-0 items-center justify-center border border-slate-200/50 transition-colors">
                          <a.icon className="w-4 h-4 text-slate-500 group-hover:text-blue-600 transition-colors" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-700 group-hover:text-blue-700 transition-colors">{a.label}</p>
                          <p className="text-[10px] text-slate-400 truncate">{a.desc}</p>
                        </div>
                      </Button>
                    </Link>
                  ))}
                </div>

                <div className="pt-3 border-t border-slate-100">
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Suggested Actions</p>
                  {leases.some(l => l.end_date && new Date(l.end_date) < new Date(Date.now() + 90 * 86400000)) ? (
                    <Card className="bg-amber-50 border-amber-200 shadow-none hover:shadow-sm transition-shadow cursor-pointer">
                      <CardContent className="p-3">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="text-sm font-bold text-amber-800 leading-tight">Lease Expiry Alert</p>
                            <p className="text-xs text-amber-600 mt-0.5 leading-snug">1 lease expiring within 3 months. Review renewal terms now.</p>
                            <Button variant="link" className="text-[11px] h-auto p-0 mt-1 text-amber-700 font-bold">Review Leases &rarr;</Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card className="bg-emerald-50 border-emerald-100 shadow-none">
                      <CardContent className="p-3">
                        <div className="flex items-start gap-2.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="text-sm font-bold text-emerald-800 leading-tight">All Clear</p>
                            <p className="text-xs text-emerald-600 mt-0.5">No immediate lease expirations or missing data detected.</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {expenses?.length === 0 && (
                     <Card className="bg-blue-50 border-blue-100 shadow-none mt-2 hover:shadow-sm transition-shadow cursor-pointer">
                       <CardContent className="p-3">
                         <div className="flex items-start gap-2.5">
                           <DollarSign className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
                           <div>
                             <p className="text-sm font-bold text-blue-800 leading-tight">Missing Expense Data</p>
                             <p className="text-xs text-blue-600 mt-0.5 leading-snug">No operating expenses recorded for this month.</p>
                             <Link to={createPageUrl("AddExpense") + `?property=${propertyId}`}>
                               <Button variant="link" className="text-[11px] h-auto p-0 mt-1 text-blue-700 font-bold">Add Expense &rarr;</Button>
                             </Link>
                           </div>
                         </div>
                       </CardContent>
                     </Card>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Financial Summary */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-50 bg-slate-50/30">
              <CardTitle className="text-base font-bold text-slate-800 flex items-center justify-between">
                <span>Financial Summary — FY {new Date().getFullYear()}</span>
                <Badge variant="outline" className="text-[10px] bg-slate-50">YTD Actuals</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div className="p-5 bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-shadow">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Total Revenue</p>
                  <div className="flex items-end justify-between">
                    <p className="text-2xl font-bold text-slate-900">$4,820,000</p>
                    <div className="flex flex-col items-end">
                      <p className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">+5.2% YoY</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-50 space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-500">
                      <span>Base Rent</span><span className="font-semibold text-slate-700">$4.1M</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-500">
                      <span>CAM Recovery</span><span className="font-semibold text-slate-700">$720K</span>
                    </div>
                  </div>
                </div>

                <div className="p-5 bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-shadow">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Total Expenses</p>
                  <div className="flex items-end justify-between">
                    <p className="text-2xl font-bold text-red-600 flex items-center"><AlertTriangle className="w-4 h-4 mr-1 mb-0.5"/>$1,680,000</p>
                    <div className="flex flex-col items-end">
                      <p className="text-xs font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">+7.1% YoY</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-50 space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-500 items-center">
                      <span className="text-red-500 font-semibold">• Insurance</span><span className="font-semibold text-slate-700">+$45K (Spike)</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-500">
                      <span>Utilities</span><span className="font-semibold text-slate-700">+$12K</span>
                    </div>
                  </div>
                </div>

                <div className="p-5 bg-blue-50/50 border border-blue-100 rounded-xl shadow-sm hover:shadow-md transition-shadow">
                  <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-1">Net Operating Income</p>
                  <div className="flex items-end justify-between">
                    <p className="text-2xl font-bold text-slate-900">$3,140,000</p>
                    <div className="flex flex-col items-end">
                      <p className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">+4.2% YoY</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-blue-100/50 space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-600">
                      <span>NOI Margin</span><span className="font-semibold text-slate-800">65.1%</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-600">
                      <span>Yield on Cost</span><span className="font-semibold text-slate-800">8.4%</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Buildings & Units Tab */}
        <TabsContent value="buildings" className="mt-4 space-y-6">
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddBuilding(true)}><Plus className="w-4 h-4 mr-1" />Add Building</Button>
          </div>
          {buildings.length > 0 ? buildings.map(b => (
            <Card key={b.id}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">{b.name} <Badge variant="secondary" className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100">Building</Badge></h3>
                    <p className="text-xs text-slate-500 mt-1">{b.total_sqft?.toLocaleString() || 0} RSV SF · {b.floors || 1} Floors</p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <Link to={createPageUrl("AddExpense") + `?property=${propertyId}&building=${b.id}`}>
                      <Button size="sm" variant="outline" className="text-xs h-8"><DollarSign className="w-3 h-3 mr-1" />Log Expense</Button>
                    </Link>
                    <Link to={createPageUrl("LeaseUpload") + `?property=${propertyId}&building=${b.id}`}>
                      <Button size="sm" variant="outline" className="text-xs h-8"><Upload className="w-3 h-3 mr-1" />Upload Lease</Button>
                    </Link>
                    <Link to={createPageUrl("CreateBudget") + `?property=${propertyId}&building=${b.id}`}>
                      <Button size="sm" variant="outline" className="text-xs h-8 text-emerald-700 border-emerald-200 hover:bg-emerald-50"><BarChart2 className="w-3 h-3 mr-1" />Generate Budget</Button>
                    </Link>
                    <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-xs h-8" onClick={() => { setSelectedBuildingId(b.id); setShowAddUnit(true); }}><Plus className="w-3 h-3 mr-1" />Add Unit</Button>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="text-[11px]">UNIT ID</TableHead>
                      <TableHead className="text-[11px]">FLOOR</TableHead>
                      <TableHead className="text-[11px]">SQUARE FEET</TableHead>
                      <TableHead className="text-[11px]">STATUS</TableHead>
                      <TableHead className="text-[11px]">TENANT</TableHead>
                      <TableHead className="text-[11px] font-semibold text-slate-500">LEASE STATUS</TableHead>
                      <TableHead className="text-[11px] font-semibold text-slate-500 text-right">ACTIONS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {units.filter(u => u.building_id === b.id).map(u => (
                      <TableRow key={u.id}>
                        <TableCell className="text-sm font-medium text-blue-600">{u.unit_number}</TableCell>
                        <TableCell className="text-sm">{u.floor}</TableCell>
                        <TableCell className="text-sm">{u.square_footage?.toLocaleString()}</TableCell>
                        <TableCell><Badge className={`${statusColors[u.status] || 'bg-slate-100'} text-[10px] uppercase`}>{u.status?.replace('_', ' ') || 'vacant'}</Badge></TableCell>
                        <TableCell className="text-sm">—</TableCell>
                        <TableCell><Badge className={`${leaseStatusColors[u.lease_status] || 'bg-slate-100 text-slate-400'} text-[10px] uppercase font-semibold`}>{u.lease_status?.replace('_', '-') || '—'}</Badge></TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {u.lease_id ? (
                              <Button size="sm" variant="ghost" className="h-7 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50">View Lease</Button>
                            ) : u.status === 'vacant' ? (
                              <Link to={createPageUrl("LeaseUpload") + `?property=${propertyId}&unit=${u.id}`}>
                                <Button size="sm" variant="outline" className="h-7 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50">Add Lease</Button>
                              </Link>
                            ) : null}
                            <Link to={createPageUrl("CreateBudget") + `?property=${propertyId}&unit=${u.id}`}>
                              <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50"><BarChart2 className="w-3 h-3 mr-1" />Budget</Button>
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {units.filter(u => u.building_id === b.id).length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center py-6 text-slate-400 text-sm">No units in this building yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )) : (
            <Card>
              <CardContent className="p-8 text-center text-slate-400">
                <p className="mb-3">No buildings configured. Add a building to start managing units.</p>
                <Button onClick={() => setShowAddBuilding(true)}><Plus className="w-4 h-4 mr-1" />Add Building</Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Leases Tab */}
        <TabsContent value="leases" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex justify-between items-center mb-4">
                <p className="text-sm text-slate-500">{leases.length} leases for this property</p>
                <Link to={createPageUrl("LeaseUpload") + `?property=${propertyId}`}><Button size="sm" className="bg-blue-600 hover:bg-blue-700"><Upload className="w-4 h-4 mr-1" />Upload Lease</Button></Link>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[11px]">TENANT</TableHead>
                    <TableHead className="text-[11px]">UNIT</TableHead>
                    <TableHead className="text-[11px]">TYPE</TableHead>
                    <TableHead className="text-[11px]">START</TableHead>
                    <TableHead className="text-[11px]">END</TableHead>
                    <TableHead className="text-[11px]">ANNUAL RENT</TableHead>
                    <TableHead className="text-[11px]">STATUS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leases.map(l => (
                    <TableRow key={l.id}>
                      <TableCell className="text-sm font-medium">{l.tenant_name}</TableCell>
                      <TableCell className="text-sm">{l.unit_id?.substring(0, 8) || '—'}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{l.lease_type}</Badge></TableCell>
                      <TableCell className="text-sm">{l.start_date || '—'}</TableCell>
                      <TableCell className="text-sm">{l.end_date || '—'}</TableCell>
                      <TableCell className="text-sm font-mono">${l.annual_rent?.toLocaleString() || '—'}</TableCell>
                      <TableCell><Badge className={`${leaseStatusColors[l.status]} text-[10px] uppercase`}>{l.status?.replace('_', '-')}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {leases.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-8 text-slate-400 text-sm">No leases yet</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Expenses Tab - Inline with historical comparison */}
        <TabsContent value="expenses" className="mt-4">
          <PropertyExpensesTab propertyId={propertyId} />
        </TabsContent>

        {/* CAM Tab - Inline with historical comparison */}
        <TabsContent value="cam" className="mt-4">
          <PropertyCAMTab propertyId={propertyId} />
        </TabsContent>

        {/* Budgets Tab - Inline with historical comparison */}
        <TabsContent value="budgets" className="mt-4">
          <PropertyBudgetsTab propertyId={propertyId} />
        </TabsContent>

        {/* Stakeholders - Navigate to module */}
        <TabsContent value="stakeholders" className="mt-4">
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-slate-400 text-sm">Navigate to the stakeholders module for this property</p>
              <Link to={createPageUrl("Stakeholders") + `?property=${propertyId}`}>
                <Button className="mt-4" variant="outline">Go to Stakeholders</Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Building Dialog */}
      <Dialog open={showAddBuilding} onOpenChange={setShowAddBuilding}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Building</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Building Name *</Label><Input value={buildingForm.name} onChange={e => setBuildingForm({...buildingForm, name: e.target.value})} placeholder="e.g. Building A" /></div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Total SF</Label><Input type="number" value={buildingForm.total_sqft} onChange={e => setBuildingForm({...buildingForm, total_sqft: e.target.value})} /></div>
              <div><Label>Floors</Label><Input type="number" value={buildingForm.floors} onChange={e => setBuildingForm({...buildingForm, floors: parseInt(e.target.value) || 1})} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddBuilding(false)}>Cancel</Button>
            <Button onClick={() => createBuildingMutation.mutate({ name: buildingForm.name, total_sqft: parseInt(buildingForm.total_sqft) || 0, floors: buildingForm.floors || 1, property_id: propertyId, org_id: property.org_id })} disabled={!buildingForm.name || createBuildingMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {createBuildingMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Create Building
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Unit Dialog */}
      <Dialog open={showAddUnit} onOpenChange={setShowAddUnit}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Unit</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {buildings.length > 0 && (
              <div>
                <Label>Building</Label>
                <Select value={selectedBuildingId || ""} onValueChange={v => setSelectedBuildingId(v)}>
                  <SelectTrigger><SelectValue placeholder="Select building" /></SelectTrigger>
                  <SelectContent>
                    {buildings.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Unit ID *</Label><Input value={unitForm.unit_number} onChange={e => setUnitForm({...unitForm, unit_number: e.target.value})} placeholder="e.g. A-101" /></div>
              <div><Label>Floor</Label><Input value={unitForm.floor || ""} onChange={e => setUnitForm({...unitForm, floor: e.target.value})} placeholder="Floor 1" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Square Feet</Label><Input type="number" value={unitForm.square_footage} onChange={e => setUnitForm({...unitForm, square_footage: e.target.value})} /></div>
              <div>
                <Label>Status</Label>
                <Select value={unitForm.status} onValueChange={v => setUnitForm({...unitForm, status: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vacant">Vacant</SelectItem>
                    <SelectItem value="leased">Leased</SelectItem>
                    <SelectItem value="pre_lease">Pre-Lease</SelectItem>
                    <SelectItem value="owner_occupied">Owner Occupied (Revenue=0, Internal Expenses)</SelectItem>
                    <SelectItem value="under_construction">Under Construction (Excluded from CAM)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {unitForm.status !== 'vacant' && (
              <div><Label>Tenant Name (optional)</Label><Input value={unitForm.tenant_name || ""} onChange={e => setUnitForm({...unitForm, tenant_name: e.target.value})} /></div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddUnit(false)}>Cancel</Button>
            <Button onClick={() => createUnitMutation.mutate({
              unit_number: unitForm.unit_number,
              square_footage: parseInt(unitForm.square_footage) || 0,
              status: unitForm.status,
              building_id: selectedBuildingId || null,
              property_id: propertyId,
              org_id: property.org_id,
            })} disabled={!unitForm.unit_number || createUnitMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {createUnitMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Create Unit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}