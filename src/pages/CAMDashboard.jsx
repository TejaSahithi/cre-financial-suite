import React, { useState, useCallback } from "react";
import PipelineActions, { CAM_ACTIONS } from "@/components/PipelineActions";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Calculator, ArrowRight, Plus, Trash2, DollarSign, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ScopeSelector from "@/components/ScopeSelector";
import CAMReviewTab from "@/components/cam/CAMReviewTab";

const DEFAULT_CAM_RULES = [
  { id: "admin_fee", name: "Admin Fee", type: "percentage", enabled: true, value: 10, description: "Administrative fee applied to total CAM pool" },
  { id: "gross_up", name: "Gross-Up Clause", type: "toggle", enabled: false, value: 95, description: "Gross up expenses to assumed occupancy level (%)" },
  { id: "base_year_stop", name: "Base Year / Expense Stop", type: "toggle", enabled: false, value: 0, description: "Tenant only pays increases above base year CAM" },
  { id: "exclude_vacant", name: "Exclude Vacant from Allocation", type: "toggle", enabled: false, description: "Exclude vacant units from pro-rata share calculation" },
  { id: "cam_cap", name: "CAM Cap (Annual Increase)", type: "percentage", enabled: true, value: 5, description: "Max annual % increase in CAM charges" },
  { id: "cpi_escalation", name: "CPI-Based Escalation", type: "cpi", enabled: false, value: 3, cpi_index: "CPI-U", description: "Annual CAM increase tied to CPI index" },
  { id: "controllable_cap", name: "Controllable Expense Cap", type: "percentage", enabled: false, value: 5, description: "Cap only on controllable expenses (separate from non-controllable)" },
  { id: "proration", name: "Mid-Year Proration", type: "toggle", enabled: true, description: "Prorate CAM for tenants with mid-year lease start/end" },
];

const expenseCategories = [
  { name: "Property Tax", controllable: false },
  { name: "Insurance", controllable: false },
  { name: "Common Area Utilities", controllable: false },
  { name: "Landscaping", controllable: true },
  { name: "Snow Removal", controllable: true },
  { name: "Parking Lot Maintenance", controllable: true },
  { name: "Elevator Maintenance", controllable: true },
  { name: "Security Services", controllable: true },
  { name: "Janitorial", controllable: true },
  { name: "Trash Removal", controllable: true },
  { name: "Fire Systems", controllable: false },
  { name: "HVAC Maintenance", controllable: true },
  { name: "Management Fee", controllable: true },
];

// ─── Snapshot fetcher ──────────────────────────────────────────────────────
async function fetchCAMSnapshot(propertyId, fiscalYear) {
  if (!supabase) return null;
  const query = supabase
    .from("computation_snapshots")
    .select("*")
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1);
  if (propertyId && propertyId !== "all") query.eq("property_id", propertyId);
  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;
  return data[0];
}

export default function CAMDashboard() {
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");
  const { data: leaseList = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const queryClient = useQueryClient();
  const { trigger: triggerCompute, isTriggering } = useComputeTrigger();

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  // The single source of truth for which property the compute targets.
  // ScopeSelector returns "all" when nothing is picked — treat that as null.
  const targetPropertyId = scopeProperty !== "all" ? scopeProperty : null;

  // Multi-level scope: most-specific selection wins (unit > building > property)
  const targetScopeLevel =
    scopeUnit !== "all"
      ? "unit"
      : scopeBuilding !== "all"
      ? "building"
      : targetPropertyId
      ? "property"
      : null;

  const targetScopeId =
    targetScopeLevel === "unit"
      ? scopeUnit
      : targetScopeLevel === "building"
      ? scopeBuilding
      : targetScopeLevel === "property"
      ? targetPropertyId
      : null;

  const targetScopeLabel = (() => {
    if (targetScopeLevel === "unit") {
      const u = allUnits.find((x) => x.id === scopeUnit);
      return u ? `Unit ${u.unit_number || u.unit_id_code || u.name || u.id.slice(0, 6)}` : "Unit";
    }
    if (targetScopeLevel === "building") {
      const b = allBuildings.find((x) => x.id === scopeBuilding);
      return b ? `Building ${b.name}` : "Building";
    }
    if (targetScopeLevel === "property") {
      const p = properties.find((x) => x.id === targetPropertyId);
      return p ? p.name : "Property";
    }
    return null;
  })();

  // Read CAM metrics from computation_snapshots — no client-side math
  const {
    data: camSnapshot,
    refetch: refetchSnapshot,
  } = useQuery({
    queryKey: ["cam-snapshot", scopeProperty, currentYear],
    queryFn: () => fetchCAMSnapshot(scopeProperty, currentYear),
    refetchInterval: (data) => (data ? false : 5000),
  });

  const snapshotOutputs = camSnapshot?.outputs ?? {};
  const currentTotal = snapshotOutputs.total_cam ?? 0;
  const prevTotal = snapshotOutputs.prev_year_total ?? 0;
  const camBudgeted = snapshotOutputs.budgeted_cam ?? 0;
  const leaseCAMTotal = snapshotOutputs.total_billed ?? 0;

  // Refresh snapshot + cached lists after any compute action succeeds
  const refreshAfterCompute = useCallback(() => {
    // Give the edge function a moment to commit before refetch
    setTimeout(() => {
      refetchSnapshot();
      queryClient.invalidateQueries({ queryKey: ["cam-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["CAMCalculation"] });
    }, 800);
  }, [queryClient, refetchSnapshot]);

  // Manual "Calculate CAM Allocation" button on the Calculate tab
  const handleCalculate = async () => {
    if (!targetPropertyId) {
      toast.error("Select a property in the Scope selector first");
      return;
    }
    try {
      await triggerCompute(
        "compute-cam",
        {
          property_id: targetPropertyId,
          fiscal_year: currentYear,
          scope_level: targetScopeLevel,
          scope_id: targetScopeId,
        },
        {
          successMessage: `CAM calculated for ${targetScopeLabel} — refreshing dashboard…`,
        }
      );
      refreshAfterCompute();
    } catch {
      /* useComputeTrigger already toasts */
    }
  };

  const [camRules, setCamRules] = useState(DEFAULT_CAM_RULES);
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRule, setNewRule] = useState({ name: "", type: "percentage", value: 0, description: "", enabled: true });

  const [config, setConfig] = useState({
    building_sqft: 100000,
    occupied_sqft: 85000,
    allocation_method: "pro_rata",
  });

  const [expenseAmounts, setExpenseAmounts] = useState({});

  const toggleRule = (id) => {
    setCamRules(rules => rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const updateRuleValue = (id, value) => {
    setCamRules(rules => rules.map(r => r.id === id ? { ...r, value: parseFloat(value) || 0 } : r));
  };

  const updateRuleCPI = (id, index) => {
    setCamRules(rules => rules.map(r => r.id === id ? { ...r, cpi_index: index } : r));
  };

  const deleteRule = (id) => {
    setCamRules(rules => rules.filter(r => r.id !== id));
  };

  const addCustomRule = () => {
    if (!newRule.name) return;
    setCamRules(rules => [...rules, { ...newRule, id: `custom_${Date.now()}` }]);
    setNewRule({ name: "", type: "percentage", value: 0, description: "", enabled: true });
    setShowAddRule(false);
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Calculator} title="CAM Engine" subtitle="Configure rules, manage allocations, and calculate tenant charges at every level" iconColor="from-teal-500 to-cyan-600">
        <Link to={createPageUrl("CreateBudget")}>
          <Button variant="outline" size="sm">Budget Studio <ArrowRight className="w-4 h-4 ml-1" /></Button>
        </Link>
      </PageHeader>

      <PipelineActions
        propertyId={targetPropertyId}
        fiscalYear={currentYear}
        actions={CAM_ACTIONS}
        onComplete={refreshAfterCompute}
        scopeLevel={targetScopeLevel}
        scopeId={targetScopeId}
      />

      <ScopeSelector
        properties={properties}
        buildings={allBuildings}
        units={allUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={(v) => { setScopeProperty(v); setScopeBuilding("all"); setScopeUnit("all"); }}
        onBuildingChange={(v) => { setScopeBuilding(v); setScopeUnit("all"); }}
        onUnitChange={setScopeUnit}
        showUnit
      />

      {!targetPropertyId ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Pick a property in the Scope selector above to enable CAM compute and export. Optionally drill down into a building or unit for level-specific CAM.
        </div>
      ) : (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Compute scope: <span className="font-semibold capitalize">{targetScopeLevel}</span>
          {" → "}
          <span className="font-semibold">{targetScopeLabel}</span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label={`CAM Pool (${currentYear})`} value={`$${currentTotal.toLocaleString()}`} icon={Calculator} color="bg-teal-50 text-teal-600" trend={prevTotal > 0 ? parseFloat(((currentTotal - prevTotal) / prevTotal * 100).toFixed(1)) : undefined} />
        <MetricCard label={`Prior Year (${prevYear})`} value={`$${prevTotal.toLocaleString()}`} icon={DollarSign} color="bg-slate-100 text-slate-500" sub="Historical baseline" />
        <MetricCard label={`Budgeted CAM`} value={`$${camBudgeted.toLocaleString()}`} icon={TrendingUp} color="bg-blue-50 text-blue-600" sub={`FY ${currentYear}`} />
        <MetricCard label="Lease CAM Revenue" value={`$${leaseCAMTotal.toLocaleString()}`} icon={DollarSign} color="bg-amber-50 text-amber-600" sub="From active leases" />
      </div>

      <Tabs defaultValue="rules">
        <TabsList className="bg-white border">
          <TabsTrigger value="rules">CAM Rules</TabsTrigger>
          <TabsTrigger value="expenses">Expense Entry</TabsTrigger>
          <TabsTrigger value="calculate">Calculate</TabsTrigger>
          <TabsTrigger value="review">CAM Review</TabsTrigger>
        </TabsList>

        {/* CAM Rules Tab */}
        <TabsContent value="rules" className="mt-4 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">CAM Rules & Configuration</h2>
              <p className="text-xs text-slate-500">Enable/disable rules, set values, or add custom rules. These apply to CAM calculations.</p>
            </div>
            <Button onClick={() => setShowAddRule(true)} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />Add Custom Rule
            </Button>
          </div>

          <div className="space-y-3">
            {camRules.map(rule => (
              <Card key={rule.id} className={`transition-all ${rule.enabled ? 'border-l-4 border-l-blue-500' : 'opacity-60'}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <Switch checked={rule.enabled} onCheckedChange={() => toggleRule(rule.id)} />
                        <span className="text-sm font-bold text-slate-900">{rule.name}</span>
                        {rule.type === 'cpi' && <Badge className="bg-purple-100 text-purple-700 text-[10px]">CPI-BASED</Badge>}
                        {rule.type === 'percentage' && <Badge variant="outline" className="text-[10px]">%</Badge>}
                        {rule.type === 'toggle' && <Badge variant="outline" className="text-[10px]">ON/OFF</Badge>}
                        {rule.id.startsWith('custom_') && <Badge className="bg-amber-100 text-amber-700 text-[10px]">CUSTOM</Badge>}
                      </div>
                      <p className="text-xs text-slate-500 ml-11">{rule.description}</p>
                    </div>

                    <div className="flex items-center gap-2">
                      {rule.enabled && rule.type === 'percentage' && (
                        <div className="flex items-center gap-1">
                          <Input type="number" value={rule.value} onChange={e => updateRuleValue(rule.id, e.target.value)} className="w-20 h-8 text-sm text-right" />
                          <span className="text-xs text-slate-400">%</span>
                        </div>
                      )}
                      {rule.enabled && rule.type === 'toggle' && rule.value !== undefined && rule.value !== null && (
                        <div className="flex items-center gap-1">
                          <Input type="number" value={rule.value} onChange={e => updateRuleValue(rule.id, e.target.value)} className="w-20 h-8 text-sm text-right" placeholder="Value" />
                          {rule.id === 'gross_up' && <span className="text-xs text-slate-400">% occ.</span>}
                          {rule.id === 'base_year_stop' && <span className="text-xs text-slate-400">$</span>}
                        </div>
                      )}
                      {rule.enabled && rule.type === 'cpi' && (
                        <div className="flex items-center gap-2">
                          <Select value={rule.cpi_index || "CPI-U"} onValueChange={v => updateRuleCPI(rule.id, v)}>
                            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="CPI-U">CPI-U</SelectItem>
                              <SelectItem value="CPI-W">CPI-W</SelectItem>
                              <SelectItem value="custom">Custom Rate</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input type="number" value={rule.value} onChange={e => updateRuleValue(rule.id, e.target.value)} className="w-20 h-8 text-sm text-right" placeholder="Rate %" />
                          <span className="text-xs text-slate-400">%</span>
                        </div>
                      )}
                      {rule.enabled && (
                        <Badge variant="outline" className="text-[10px] font-mono bg-slate-50">
                          {rule.type === 'toggle' && (rule.value !== undefined && rule.value !== null)
                            ? (rule.id === 'gross_up' ? `${rule.value}%` : rule.id === 'base_year_stop' ? `$${rule.value}` : rule.value)
                            : rule.type === 'toggle' ? 'Active' 
                            : rule.type === 'cpi' ? `${rule.value}% ${rule.cpi_index || 'CPI-U'}`
                            : `${rule.value}%`}
                        </Badge>
                      )}
                      {rule.id.startsWith('custom_') && (
                        <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)} className="text-red-400 hover:text-red-600">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Expense Entry Tab */}
        <TabsContent value="expenses" className="mt-4 space-y-6">
          {/* Classification legend */}
          <div className="grid grid-cols-3 gap-4">
            <Card className="border-l-4 border-l-emerald-500">
              <CardContent className="p-4">
                <p className="text-sm font-bold text-emerald-700">Recoverable</p>
                <p className="text-[10px] text-slate-500">Property Tax, Insurance, Utilities, Security, Janitorial, HVAC...</p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-red-500">
              <CardContent className="p-4">
                <p className="text-sm font-bold text-red-600">Non-Recoverable</p>
                <p className="text-[10px] text-slate-500">Mortgage, Depreciation, Capital Improvements, Legal Disputes...</p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-amber-500">
              <CardContent className="p-4">
                <p className="text-sm font-bold text-amber-600">Controllable (Capped)</p>
                <p className="text-[10px] text-slate-500">Maintenance, Landscaping, Security, Janitorial, Management Fee...</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enter Operating Expenses</CardTitle>
              <p className="text-xs text-slate-500">Only recoverable expenses go into the CAM pool</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {expenseCategories.map(cat => (
                <div key={cat.name} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-slate-700">{cat.name}</p>
                    <p className="text-[10px] text-slate-400">{cat.controllable ? '🔒 Controllable (capped)' : '🔥 Non-controllable'}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">$</span>
                    <Input type="number" className="w-28 h-8 text-sm text-right" placeholder="0"
                      value={expenseAmounts[cat.name] || ""}
                      onChange={e => setExpenseAmounts({ ...expenseAmounts, [cat.name]: e.target.value })} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Calculate Tab */}
        <TabsContent value="calculate" className="mt-4 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Building Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div><Label className="text-xs">Building SqFt</Label><Input type="number" value={config.building_sqft} onChange={e => setConfig({ ...config, building_sqft: parseInt(e.target.value) || 0 })} /></div>
                <div><Label className="text-xs">Occupied SqFt</Label><Input type="number" value={config.occupied_sqft} onChange={e => setConfig({ ...config, occupied_sqft: parseInt(e.target.value) || 0 })} /></div>
                <div>
                  <Label className="text-xs">Allocation Method</Label>
                  <Select value={config.allocation_method} onValueChange={v => setConfig({ ...config, allocation_method: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pro_rata">Pro-Rata by SqFt</SelectItem>
                      <SelectItem value="equal">Equal Distribution</SelectItem>
                      <SelectItem value="weighted">Weighted Allocation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Active rules summary */}
              <div className="bg-slate-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Active Rules</p>
                <div className="flex flex-wrap gap-2">
                  {camRules.filter(r => r.enabled).map(r => (
                    <Badge key={r.id} className="bg-blue-100 text-blue-700 text-[10px]">
                      {r.name}{r.type !== 'toggle' ? `: ${r.value}%` : ''}{r.cpi_index ? ` (${r.cpi_index})` : ''}
                    </Badge>
                  ))}
                </div>
              </div>

              <Button
                onClick={handleCalculate}
                disabled={isTriggering || !targetPropertyId}
                className="w-full bg-red-500 hover:bg-red-600 h-12 text-base font-semibold"
                title={!targetPropertyId ? "Select a property in the Scope selector first" : "Run compute-cam for the selected property"}
              >
                <Calculator className="w-5 h-5 mr-2" />
                {isTriggering ? "Calculating…" : "Calculate CAM Allocation"}
              </Button>
              {!targetPropertyId && (
                <p className="text-xs text-amber-600 text-center">Select a property in the Scope selector above to enable this button.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        {/* CAM Review Tab */}
        <TabsContent value="review" className="mt-4">
          <CAMReviewTab
            camCalcs={camCalcs}
            expenses={expenses}
            leases={leaseList}
            currentYear={currentYear}
            prevYear={prevYear}
            scopeProperty={scopeProperty}
          />
        </TabsContent>
      </Tabs>

      {/* Add Custom Rule Dialog */}
      <Dialog open={showAddRule} onOpenChange={setShowAddRule}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Custom CAM Rule</DialogTitle><DialogDescription>Define a new rule for CAM calculations</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div><Label>Rule Name *</Label><Input value={newRule.name} onChange={e => setNewRule({ ...newRule, name: e.target.value })} placeholder="e.g. Parking Surcharge" /></div>
            <div>
              <Label>Rule Type</Label>
              <Select value={newRule.type} onValueChange={v => setNewRule({ ...newRule, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="toggle">Toggle (ON/OFF)</SelectItem>
                  <SelectItem value="cpi">CPI-Based</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newRule.type !== 'toggle' && (
              <div><Label>Default Value (%)</Label><Input type="number" value={newRule.value} onChange={e => setNewRule({ ...newRule, value: parseFloat(e.target.value) || 0 })} /></div>
            )}
            <div><Label>Description</Label><Input value={newRule.description} onChange={e => setNewRule({ ...newRule, description: e.target.value })} placeholder="Brief description of the rule" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddRule(false)}>Cancel</Button>
            <Button onClick={addCustomRule} disabled={!newRule.name} className="bg-blue-600 hover:bg-blue-700">Add Rule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}