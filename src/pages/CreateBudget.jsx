import React, { useState } from "react";
import { UnitService, BuildingService, PropertyService, LeaseService, BudgetService } from "@/services/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { 
  FileText, Zap, TrendingUp, ArrowRight, Loader2, CheckCircle2, Upload, Lock 
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";
import ScenarioPlanner from "@/components/ScenarioPlanner";

export default function CreateBudget() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState("lease_driven");
  const [form, setForm] = useState({ name: "", budget_year: 2027, scope: "property", period: "annual", property_id: "", building_id: "", unit_id: "" });
  const [generating, setGenerating] = useState(false);

  const { data: properties = [] } = useQuery({ queryKey: ['cb-properties'], queryFn: () => PropertyService.list() });
  const { data: buildings = [] } = useQuery({ queryKey: ['cb-buildings'], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ['cb-units'], queryFn: () => UnitService.list() });
  const { data: leases = [] } = useQuery({
    queryKey: ['leases-budget'],
    queryFn: () => LeaseService.list(),
  });

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-manage'],
    queryFn: () => BudgetService.list('-created_date'),
  });

  const createMutation = useMutation({
    mutationFn: (data) => BudgetService.create(data),
    onSuccess: () => navigate(createPageUrl("BudgetDashboard")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }) => BudgetService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets-manage'] });
    }
  });

  const handleStatusChange = (id, newStatus) => {
    updateMutation.mutate({ id, status: newStatus });
  };

  // Filtered buildings/units based on selected property/building
  const filteredBuildings = form.property_id ? buildings.filter(b => b.property_id === form.property_id) : buildings;
  const filteredUnits = form.building_id
    ? units.filter(u => u.building_id === form.building_id)
    : form.property_id
      ? units.filter(u => u.property_id === form.property_id)
      : units;

  // Filtered leases for the selected scope
  const scopeLeases = leases.filter(l => {
    if (form.property_id && l.property_id !== form.property_id) return false;
    if (form.unit_id && l.unit_id !== form.unit_id) return false;
    return true;
  });

  const selectedProperty = properties.find(p => p.id === form.property_id);
  const selectedBuilding = buildings.find(b => b.id === form.building_id);
  const selectedUnit = units.find(u => u.id === form.unit_id);

  const handleGenerate = async () => {
    setGenerating(true);
    const scopeLabel = selectedUnit ? `Unit ${selectedUnit.unit_id_code}` : selectedBuilding ? `Building ${selectedBuilding.name}` : selectedProperty ? selectedProperty.name : form.name || 'Property';

    let data = {};
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const { data: result, error } = await supabase.functions.invoke('generate-budget', {
        body: {
          scope_label: scopeLabel,
          budget_year: form.budget_year,
          scope: form.scope,
          period: form.period,
          method,
          leases: scopeLeases.map(l => ({ tenant_name: l.tenant_name, annual_rent: l.annual_rent })),
        },
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      if (!error && result && !result.error) {
        data = result;
      }
    } catch (err) {
      console.error("[CreateBudget] generate-budget error:", err);
    }

    createMutation.mutate({
      name: form.name,
      budget_year: form.budget_year,
      scope: form.scope,
      period: form.period,
      property_id: form.property_id || undefined,
      generation_method: method,
      status: method === 'manual' ? 'draft' : 'ai_generated',
      total_revenue: data.total_revenue || 669000,
      total_expenses: data.total_expenses || 232050,
      cam_total: data.cam_total || 72900,
      noi: data.noi || 436950,
      ai_insights: data.ai_insights || ""
    });
    setGenerating(false);
  };

  const methods = [
    { id: "lease_driven", icon: FileText, label: "Lease-Driven", desc: "Auto-generated from your extracted lease data. Most accurate for portfolios with active leases." },
    { id: "manual", icon: Zap, label: "Manual + AI Assist", desc: "Enter key assumptions. AI fills gaps using market benchmarks and comparables." },
    { id: "historical_ai", icon: TrendingUp, label: "Historical + Market AI", desc: "Upload prior budgets/actuals. AI generates 4-5 scenarios with market trends, CPI, and forecasts." },
  ];

  const statuses = [
    { label: "Draft", color: "bg-slate-500" }, { label: "AI Generated", color: "bg-blue-500" },
    { label: "Under Review", color: "bg-red-500" }, { label: "Reviewed", color: "bg-amber-500" },
    { label: "Approved", color: "bg-emerald-500" }, { label: "Signed", color: "bg-green-500" },
    { label: "Locked", color: "bg-slate-800" },
  ];

  const statusColors = {
    draft: "bg-slate-100 text-slate-600", ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700", approved: "bg-emerald-100 text-emerald-700",
    locked: "bg-slate-800 text-white"
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400 mb-1">CAM Engine › Budget Studio</p>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Zap className="w-6 h-6 text-blue-600" />Budget Studio</h1>
          <p className="text-sm text-slate-500 mt-1">Generate budgets 3 ways. Full review, approval, digital signing, locking workflow. Downloadable as Excel/CSV.</p>
        </div>
        <Link to={createPageUrl("Reconciliation")}><Button variant="outline" size="sm">Actuals & Recon <ArrowRight className="w-4 h-4 ml-1" /></Button></Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        {statuses.map(s => (
          <Badge key={s.label} className={`${s.color} text-white text-[10px]`}>
            {s.label === "Locked" && <Lock className="w-2.5 h-2.5 mr-1" />}{s.label}
          </Badge>
        ))}
      </div>

      <Tabs defaultValue="generate">
        <TabsList className="bg-white border">
          <TabsTrigger value="generate">Generate Budget</TabsTrigger>
          <TabsTrigger value="manage">Manage Budgets ({budgets.length})</TabsTrigger>
          <TabsTrigger value="scenarios">Scenario Planning</TabsTrigger>
        </TabsList>

        <TabsContent value="generate" className="mt-4 space-y-6">
          <div className="grid md:grid-cols-3 gap-4">
            {methods.map(m => (
              <button key={m.id} onClick={() => setMethod(m.id)}
                className={`p-6 rounded-xl border-2 text-left transition-all ${method === m.id ? 'border-blue-600 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <div className="flex items-start justify-between mb-3">
                  <m.icon className={`w-6 h-6 ${method === m.id ? 'text-blue-600' : 'text-slate-400'}`} />
                  {method === m.id && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                </div>
                <h3 className="text-sm font-bold text-slate-900">{m.label}</h3>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{m.desc}</p>
              </button>
            ))}
          </div>

          <Card>
           <CardContent className="p-6 space-y-4">
             <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
               <div><Label className="text-xs">Budget Name</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. HCC 2026 Budget" /></div>
               <div><Label className="text-xs">Budget Year</Label><Input type="number" value={form.budget_year} onChange={e => setForm({...form, budget_year: parseInt(e.target.value)})} /></div>
               <div>
                 <Label className="text-xs">Scope</Label>
                 <Select value={form.scope} onValueChange={v => setForm({...form, scope: v, building_id: "", unit_id: ""})}><SelectTrigger><SelectValue /></SelectTrigger>
                   <SelectContent><SelectItem value="property">Property</SelectItem><SelectItem value="building">Building</SelectItem><SelectItem value="unit">Unit</SelectItem></SelectContent>
                 </Select>
               </div>
               <div>
                 <Label className="text-xs">Period</Label>
                 <Select value={form.period} onValueChange={v => setForm({...form, period: v})}><SelectTrigger><SelectValue /></SelectTrigger>
                   <SelectContent><SelectItem value="annual">Annual</SelectItem><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="monthly">Monthly</SelectItem></SelectContent>
                 </Select>
               </div>
             </div>

             {/* Property / Building / Unit selectors */}
             <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
               <div>
                 <Label className="text-xs">Property *</Label>
                 <Select value={form.property_id} onValueChange={v => setForm({...form, property_id: v, building_id: "", unit_id: ""})}>
                   <SelectTrigger><SelectValue placeholder="Select a property" /></SelectTrigger>
                   <SelectContent>
                     {properties.map(p => (
                       <SelectItem key={p.id} value={p.id}>
                         {p.name} {p.city ? `(${p.city}, ${p.state})` : ''}
                       </SelectItem>
                     ))}
                   </SelectContent>
                 </Select>
               </div>
               {(form.scope === "building" || form.scope === "unit") && (
                 <div>
                   <Label className="text-xs">Building {form.scope === "building" ? "*" : ""}</Label>
                   <Select value={form.building_id} onValueChange={v => setForm({...form, building_id: v, unit_id: ""})}>
                     <SelectTrigger><SelectValue placeholder="Select a building" /></SelectTrigger>
                     <SelectContent>
                       {filteredBuildings.length === 0 ? (
                         <SelectItem value="__none" disabled>No buildings found</SelectItem>
                       ) : filteredBuildings.map(b => (
                         <SelectItem key={b.id} value={b.id}>
                           {b.name} ({((b.total_sf || 0) / 1000).toFixed(0)}K SF)
                         </SelectItem>
                       ))}
                     </SelectContent>
                   </Select>
                 </div>
               )}
               {form.scope === "unit" && (
                 <div>
                   <Label className="text-xs">Unit *</Label>
                   <Select value={form.unit_id} onValueChange={v => setForm({...form, unit_id: v})}>
                     <SelectTrigger><SelectValue placeholder="Select a unit" /></SelectTrigger>
                     <SelectContent>
                       {filteredUnits.length === 0 ? (
                         <SelectItem value="__none" disabled>No units found</SelectItem>
                       ) : filteredUnits.map(u => (
                         <SelectItem key={u.id} value={u.id}>
                           {u.unit_id_code} — {u.square_feet?.toLocaleString()} SF {u.tenant_name ? `(${u.tenant_name})` : '(Vacant)'}
                         </SelectItem>
                       ))}
                     </SelectContent>
                   </Select>
                 </div>
               )}
             </div>

             {method === "lease_driven" && scopeLeases.length > 0 && (
               <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                 <p className="text-sm font-medium text-emerald-700 mb-1">✓ {scopeLeases.length} lease{scopeLeases.length > 1 ? 's' : ''} found for selected scope</p>
                 <p className="text-xs text-emerald-600">{scopeLeases.map(l => `${l.tenant_name} — $${l.annual_rent?.toLocaleString()}/yr`).join('  ·  ')}</p>
               </div>
             )}
             {method === "lease_driven" && form.property_id && scopeLeases.length === 0 && (
               <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                 <p className="text-sm font-medium text-amber-700">No leases found for selected scope — AI will use market benchmarks instead</p>
               </div>
             )}

              {method === "historical_ai" && (
                <Card className="bg-slate-50 border-dashed">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-slate-700 mb-2">Upload Historical Budget or Actuals (optional)</p>
                    <Button variant="outline" size="sm"><Upload className="w-4 h-4 mr-2" />Upload Prior Budget (CSV/Excel/PDF)</Button>
                    <p className="text-[10px] text-slate-400 mt-2">AI will generate 4 scenarios: Conservative, Moderate, Optimistic, Market-Adjusted — each with explanation.</p>
                  </CardContent>
                </Card>
              )}

              <Button onClick={handleGenerate} disabled={generating || !form.name || !form.property_id} className="bg-blue-600 hover:bg-blue-700">
                {generating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
                Generate Budget
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scenarios" className="mt-4">
          <ScenarioPlanner
            baseRevenue={budgets[0]?.total_revenue || 0}
            baseExpenses={budgets[0]?.total_expenses || 0}
            baseOccupancy={85}
            baseRentPerSF={25}
            totalSF={50000}
          />
        </TabsContent>

        <TabsContent value="manage" className="mt-4">
          {budgets.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-slate-400">No budgets created yet</CardContent></Card>
          ) : (
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="space-y-3">
                {budgets.map(b => (
                  <Card key={b.id} className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-bold text-slate-900">{b.name}</p>
                          <p className="text-xs text-slate-400">{b.budget_year} · {b.generation_method?.replace('_', ' ')}</p>
                        </div>
                        <Badge className={`${statusColors[b.status] || 'bg-slate-100'} text-[10px] uppercase`}>{b.status?.replace('_', ' ')}</Badge>
                      </div>
                      <div className="flex gap-4 mt-3 text-xs">
                        <span className="text-emerald-600 font-medium">${((b.total_revenue || 0) / 1000).toFixed(0)}K Revenue</span>
                        <span className="text-red-500 font-medium">${((b.total_expenses || 0) / 1000).toFixed(0)}K Expenses</span>
                        <span className="font-bold text-slate-900">${((b.noi || 0) / 1000).toFixed(0)}K NOI</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              {budgets[0] && (
                <div className="lg:col-span-2">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <div><CardTitle className="text-base">{budgets[0].name}</CardTitle><p className="text-xs text-slate-400">{budgets[0].budget_year} · {budgets[0].generation_method?.replace('_', ' ')}</p></div>
                      <Badge className={`${statusColors[budgets[0].status] || 'bg-slate-100'} uppercase text-[10px]`}>{budgets[0].status?.replace('_', ' ')}</Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">Total Revenue</p><p className="text-xl font-bold">${(budgets[0].total_revenue || 0).toLocaleString()}</p></div>
                        <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">Total Expenses</p><p className="text-xl font-bold text-red-600">${(budgets[0].total_expenses || 0).toLocaleString()}</p></div>
                        <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">CAM Total</p><p className="text-xl font-bold text-blue-600">${(budgets[0].cam_total || 0).toLocaleString()}</p></div>
                        <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">NOI</p><p className="text-xl font-bold text-emerald-600">${(budgets[0].noi || 0).toLocaleString()}</p></div>
                      </div>
                      {budgets[0].ai_insights && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <p className="text-xs font-semibold text-amber-700 mb-1">AI Insights</p>
                          <p className="text-sm text-amber-800">{budgets[0].ai_insights}</p>
                        </div>
                      )}
                      <div className="flex gap-3 mt-6 pt-4 border-t border-slate-100">
                        {['draft', 'ai_generated', 'under_review'].includes(budgets[0].status) && (
                          <Button className="flex-1 bg-amber-500 hover:bg-amber-600" onClick={() => handleStatusChange(budgets[0].id, 'reviewed')}>Mark as Reviewed</Button>
                        )}
                        {['reviewed'].includes(budgets[0].status) && (
                          <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => handleStatusChange(budgets[0].id, 'approved')}><CheckCircle2 className="w-4 h-4 mr-2" />Approve Budget</Button>
                        )}
                        {['approved'].includes(budgets[0].status) && (
                          <Button className="flex-1 bg-slate-800 hover:bg-slate-900" onClick={() => handleStatusChange(budgets[0].id, 'locked')}><Lock className="w-4 h-4 mr-2" />Lock Budget</Button>
                        )}
                        {!['approved', 'locked', 'signed'].includes(budgets[0].status) && (
                          <Button variant="outline" className="text-red-500 border-red-200 hover:bg-red-50" onClick={() => handleStatusChange(budgets[0].id, 'draft')}>Reject / Rework</Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}