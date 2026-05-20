import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { expenseService } from "@/services/expenseService";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { AlertTriangle, Info, CheckCircle, Upload, Plus, FileText, ArrowRightCircle, Check } from "lucide-react";

export default function LeaseExpenseClassification() {
  const navigate = useNavigate();

  // Filters State
  const [selectedProperty, setSelectedProperty] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [selectedUnit, setSelectedUnit] = useState("all");
  const [selectedLease, setSelectedLease] = useState("all");
  const [selectedTenant, setSelectedTenant] = useState("all");
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [activeTab, setActiveTab] = useState("all");
  const [selectedRows, setSelectedRows] = useState(new Set());

  // Base Data
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: tenants = [] } = useOrgQuery("Tenant");

  // Scope construction
  const scope = useMemo(() => ({
    property_id: selectedProperty !== "all" ? selectedProperty : null,
    building_id: selectedBuilding !== "all" ? selectedBuilding : null,
    unit_id: selectedUnit !== "all" ? selectedUnit : null,
    lease_id: selectedLease !== "all" ? selectedLease : null,
    tenant_id: selectedTenant !== "all" ? selectedTenant : null,
    fiscal_year: selectedYear !== "all" ? selectedYear : null,
  }), [selectedProperty, selectedBuilding, selectedUnit, selectedLease, selectedTenant, selectedYear]);

  // Fetch Workflow Scope Data
  const { data: scopeData, isLoading, refetch } = useQuery({
    queryKey: ['expense_recoverability_scope', scope],
    queryFn: () => expenseService.loadExpenseRecoverabilityScope(scope),
    enabled: true
  });

  const { approvedRules = [], approvedActuals = [], existingClassifications = [] } = scopeData || {};

  // Computed Totals
  const totals = useMemo(() => {
    let recoverable = 0, nonRecoverable = 0, conditional = 0, excluded = 0;
    let camEligible = 0, finalized = 0, needsReview = 0;

    existingClassifications.forEach(row => {
      const amt = Number(row.amount) || 0;
      if (row.recoverability_result === 'recoverable') recoverable += amt;
      if (row.recoverability_result === 'non_recoverable') nonRecoverable += amt;
      if (row.recoverability_result === 'conditional') conditional += amt;
      if (row.recoverability_result === 'excluded') excluded += amt;
      if (row.cam_eligible === 'yes' || row.cam_eligible === 'conditional') camEligible += amt;
      if (row.classification_status === 'finalized') finalized += amt;
      if (row.classification_status === 'exception' || row.recoverability_result === 'needs_review' || row.classification_status === 'unmatched') {
        needsReview += amt;
      }
    });

    return { recoverable, nonRecoverable, conditional, excluded, camEligible, finalized, needsReview };
  }, [existingClassifications]);

  // Mutations
  const runClassificationMutation = useMutation({
    mutationFn: () => expenseService.runExpenseClassification(scope),
    onSuccess: (res) => {
      toast.success(`Classification complete. Updated ${res.updated} rows.`);
      refetch();
    },
    onError: (err) => {
      toast.error(`Failed to run classification: ${err.message}`);
    }
  });

  const finalizeMutation = useMutation({
    mutationFn: (ids) => Promise.all(ids.map(id => expenseService.finalizeExpenseClassification(id))),
    onSuccess: () => {
      toast.success("Selected rows finalized");
      setSelectedRows(new Set());
      refetch();
    }
  });

  const sendToCamMutation = useMutation({
    mutationFn: (ids) => Promise.all(ids.map(id => expenseService.sendClassificationToCam(id))),
    onSuccess: () => {
      toast.success("Eligible rows sent to CAM");
      setSelectedRows(new Set());
      refetch();
    }
  });

  // Handlers
  const toggleRow = (id) => {
    const next = new Set(selectedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedRows(next);
  };

  const handleFinalizeSelected = () => {
    const ids = Array.from(selectedRows);
    if (!ids.length) return toast.error("Select rows to finalize");
    finalizeMutation.mutate(ids);
  };

  const handleSendToCamSelected = () => {
    const ids = Array.from(selectedRows);
    if (!ids.length) return toast.error("Select rows to send to CAM");
    sendToCamMutation.mutate(ids);
  };

  // Filtered Rows for Tabs
  const filteredRows = useMemo(() => {
    return existingClassifications.filter(row => {
      if (activeTab === 'all') return true;
      if (activeTab === 'recoverable') return row.recoverability_result === 'recoverable';
      if (activeTab === 'non_recoverable') return row.recoverability_result === 'non_recoverable';
      if (activeTab === 'conditional') return row.recoverability_result === 'conditional';
      if (activeTab === 'excluded') return row.recoverability_result === 'excluded';
      if (activeTab === 'needs_review') return ['unmatched', 'exception'].includes(row.classification_status) || row.recoverability_result === 'needs_review';
      if (activeTab === 'finalized') return row.classification_status === 'finalized';
      if (activeTab === 'sent_to_cam') return row.sent_to_cam === true;
      return true;
    });
  }, [existingClassifications, activeTab]);

  const currency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

  // Reusable Summary Card
  const StatCard = ({ title, value, colorClass = "text-slate-800", highlightClass = "border-slate-100" }) => (
    <Card className={`overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-lg border-t-4 ${highlightClass}`}>
      <CardContent className="p-5 flex flex-col justify-between h-full bg-white/80 backdrop-blur-sm">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{title}</h3>
        <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col h-full bg-slate-50/50 min-h-screen pb-20 font-sans">
      
      {/* Sleek Header & Toolbar Area */}
      <div className="bg-slate-900 border-b border-slate-800 text-white shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-4">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight">Expense Recoverability</h1>
              <Badge variant="outline" className="bg-white/10 text-indigo-200 border-indigo-500/30 font-normal hidden sm:inline-flex">Classification Engine</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate("/AddExpense")}><Plus className="w-3 h-3 mr-1"/>Add</Button>
              <Button variant="outline" size="sm" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate("/BulkImport")}><Upload className="w-3 h-3 mr-1"/>Import</Button>
              <Button variant="outline" size="sm" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate("/LeaseExpenseRules")}><FileText className="w-3 h-3 mr-1"/>Rules</Button>
            </div>
          </div>

          {/* Compact Scope Selector */}
          <div className="flex flex-wrap items-center gap-2 bg-white/5 p-2 rounded-lg border border-white/10">
            <span className="text-[10px] uppercase font-semibold text-slate-400 pl-2 mr-1">Scope:</span>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-32 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedProperty} onChange={e => setSelectedProperty(e.target.value)}>
              <option value="all">All Properties</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.property_name}</option>)}
            </select>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-32 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedBuilding} onChange={e => setSelectedBuilding(e.target.value)}>
              <option value="all">All Buildings</option>
              {buildings.filter(b => selectedProperty === 'all' || b.property_id === selectedProperty).map(b => <option key={b.id} value={b.id}>{b.building_name}</option>)}
            </select>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-28 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedUnit} onChange={e => setSelectedUnit(e.target.value)}>
              <option value="all">All Units</option>
              {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
            </select>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-32 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedLease} onChange={e => setSelectedLease(e.target.value)}>
              <option value="all">All Leases</option>
              {leases.map(l => <option key={l.id} value={l.id}>{l.tenant_name || l.id}</option>)}
            </select>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-32 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedTenant} onChange={e => setSelectedTenant(e.target.value)}>
              <option value="all">All Tenants</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.tenant_name}</option>)}
            </select>
            <select className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-200 rounded px-2 w-24 focus:ring-1 focus:ring-indigo-500 outline-none" value={selectedYear} onChange={e => setSelectedYear(e.target.value)}>
              <option value="all">All Years</option>
              <option value="2024">2024</option>
              <option value="2025">2025</option>
              <option value="2026">2026</option>
            </select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto w-full px-6 mt-6">
        <div className="space-y-4 mb-8">
          {approvedActuals.length === 0 && !isLoading && (
            <div className="bg-amber-50/80 backdrop-blur border border-amber-200 text-amber-900 p-5 rounded-xl shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all">
              <div className="flex items-start md:items-center">
                <AlertTriangle className="w-5 h-5 mr-3 text-amber-600 shrink-0 mt-0.5 md:mt-0"/> 
                <div>
                  <h4 className="font-semibold text-sm">No approved actual expenses found</h4>
                  <p className="text-xs text-amber-700/80 mt-1">Please add or import expenses and ensure they are approved before running classification for this scope.</p>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" className="bg-white text-slate-800" onClick={() => navigate("/AddExpense")}>Add Expense</Button>
                <Button variant="outline" size="sm" className="bg-white text-slate-800" onClick={() => navigate("/BulkImport")}>Bulk Import</Button>
              </div>
            </div>
          )}

          {approvedActuals.length > 0 && approvedRules.length === 0 && !isLoading && (
            <div className="bg-rose-50/80 backdrop-blur border border-rose-200 text-rose-900 p-5 rounded-xl shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all">
              <div className="flex items-start md:items-center">
                <Info className="w-5 h-5 mr-3 text-rose-600 shrink-0 mt-0.5 md:mt-0"/> 
                <div>
                  <h4 className="font-semibold text-sm">No approved lease expense rules found</h4>
                  <p className="text-xs text-rose-700/80 mt-1">You have actual expenses, but no approved lease rules. Approve your lease expense rules first to allow matching.</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="bg-white text-slate-800 shrink-0" onClick={() => navigate("/LeaseExpenseRules")}>Manage Lease Rules</Button>
            </div>
          )}

          {approvedActuals.length > 0 && approvedRules.length > 0 && existingClassifications.length === 0 && !isLoading && (
            <div className="bg-indigo-50/80 backdrop-blur border border-indigo-200 text-indigo-900 p-5 rounded-xl shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ring-1 ring-indigo-500/20">
              <div className="flex items-start md:items-center">
                <CheckCircle className="w-5 h-5 mr-3 text-indigo-600 shrink-0 mt-0.5 md:mt-0"/> 
                <div>
                  <h4 className="font-semibold text-sm">Ready to Classify</h4>
                  <p className="text-xs text-indigo-700/80 mt-1">Found {approvedActuals.length} approved expenses and {approvedRules.length} approved rules. Click run below to match them.</p>
                </div>
              </div>
              <Button onClick={() => runClassificationMutation.mutate()} size="sm" className="shrink-0 bg-indigo-600 hover:bg-indigo-700" disabled={runClassificationMutation.isPending}>
                Run Classification Engine
              </Button>
            </div>
          )}
        </div>

        {/* Action Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h2 className="text-xl font-bold text-slate-800">Classification Results</h2>
          <div className="flex gap-3">
             <Button variant="default" size="sm" className="bg-indigo-600 hover:bg-indigo-700 shadow-md transition-all hover:shadow-lg" onClick={() => runClassificationMutation.mutate()} disabled={runClassificationMutation.isPending || approvedActuals.length === 0 || approvedRules.length === 0}>
                Run Classification
             </Button>
             <Button variant="outline" size="sm" className="border-indigo-200 text-indigo-700 hover:bg-indigo-50" onClick={handleFinalizeSelected} disabled={selectedRows.size === 0 || finalizeMutation.isPending}>
               <Check className="w-4 h-4 mr-2"/> Finalize Selected
             </Button>
             <Button variant="outline" size="sm" className="border-emerald-200 text-emerald-700 hover:bg-emerald-50" onClick={handleSendToCamSelected} disabled={selectedRows.size === 0 || sendToCamMutation.isPending}>
               <ArrowRightCircle className="w-4 h-4 mr-2"/> Send Eligible to CAM
             </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <StatCard title="Actuals Loaded" value={approvedActuals.length} colorClass="text-slate-800" highlightClass="border-slate-300" />
          <StatCard title="Rules Loaded" value={approvedRules.length} colorClass="text-slate-800" highlightClass="border-slate-300" />
          <StatCard title="Matched" value={existingClassifications.length} colorClass="text-indigo-600" highlightClass="border-indigo-400" />
          <StatCard title="Recoverable" value={currency(totals.recoverable)} colorClass="text-emerald-600" highlightClass="border-emerald-400" />
          <StatCard title="Non-Recoverable" value={currency(totals.nonRecoverable)} colorClass="text-rose-600" highlightClass="border-rose-400" />
          <StatCard title="Conditional" value={currency(totals.conditional)} colorClass="text-amber-600" highlightClass="border-amber-400" />
          <StatCard title="Excluded" value={currency(totals.excluded)} colorClass="text-slate-600" highlightClass="border-slate-400" />
          <StatCard title="CAM-Eligible" value={currency(totals.camEligible)} colorClass="text-blue-600" highlightClass="border-blue-400" />
          <StatCard title="Finalized" value={currency(totals.finalized)} colorClass="text-indigo-600" highlightClass="border-indigo-400" />
          <StatCard title="Needs Review" value={currency(totals.needsReview)} colorClass="text-rose-600" highlightClass="border-rose-400" />
        </div>

        {/* Tabs and Table */}
        <Card className="border-0 shadow-lg shadow-slate-200/50 rounded-xl overflow-hidden bg-white">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="px-6 pt-4 border-b bg-slate-50/80 backdrop-blur">
              <TabsList className="bg-transparent space-x-2 h-auto pb-4">
                {['all', 'recoverable', 'non_recoverable', 'conditional', 'excluded', 'needs_review', 'finalized', 'sent_to_cam'].map(tab => (
                  <TabsTrigger 
                    key={tab} 
                    value={tab} 
                    className="data-[state=active]:bg-white data-[state=active]:text-indigo-700 data-[state=active]:shadow-sm border border-transparent data-[state=active]:border-slate-200 rounded-full px-4 py-1.5 text-xs font-medium capitalize transition-all"
                  >
                    {tab.replace(/_/g, ' ')}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value={activeTab} className="m-0 p-0">
              <div className="overflow-x-auto min-h-[400px]">
                <table className="w-full text-sm text-left border-collapse">
                  <thead className="bg-slate-50/80 backdrop-blur text-[11px] text-slate-500 uppercase tracking-wider font-semibold sticky top-0 z-10 shadow-sm border-b">
                    <tr>
                      <th className="px-4 py-4 w-12 text-center">
                        <input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer" onChange={e => setSelectedRows(e.target.checked ? new Set(filteredRows.map(r => r.id)) : new Set())} checked={filteredRows.length > 0 && selectedRows.size === filteredRows.length}/>
                      </th>
                      <th className="px-4 py-4 min-w-[200px]">Category & Subcategory</th>
                      <th className="px-4 py-4 text-right">Amount</th>
                      <th className="px-4 py-4">Recoverability</th>
                      <th className="px-4 py-4 text-center">CAM Eligible</th>
                      <th className="px-4 py-4">Status</th>
                      <th className="px-4 py-4 min-w-[250px]">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {isLoading ? (
                      <tr><td colSpan={7} className="p-16 text-center text-slate-400">Loading classification data...</td></tr>
                    ) : filteredRows.length === 0 ? (
                      <tr><td colSpan={7} className="p-16 text-center text-slate-400">
                        <div className="flex flex-col items-center justify-center">
                          <FileText className="w-10 h-10 text-slate-200 mb-3" />
                          <p>No records found for this view.</p>
                        </div>
                      </td></tr>
                    ) : filteredRows.map(row => (
                      <tr key={row.id} className="hover:bg-slate-50/80 transition-colors group">
                        <td className="px-4 py-4 text-center">
                          <input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer opacity-50 group-hover:opacity-100 transition-opacity" checked={selectedRows.has(row.id)} onChange={() => toggleRow(row.id)} />
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-semibold text-slate-800">{row.category?.replace(/_/g, " ")}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{row.subcategory?.replace(/_/g, " ")}</div>
                        </td>
                        <td className="px-4 py-4 font-bold text-slate-700 text-right">{currency(row.amount)}</td>
                        <td className="px-4 py-4">
                          <Badge variant="outline" className={`border ${row.recoverability_result === 'recoverable' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : row.recoverability_result === 'non_recoverable' ? 'bg-rose-50 text-rose-700 border-rose-200' : row.recoverability_result === 'conditional' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                            {row.recoverability_result?.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-4 py-4 text-center">
                           <span className={`inline-flex items-center justify-center px-2 py-1 rounded text-xs font-medium ${row.cam_eligible === 'yes' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                              {row.cam_eligible}
                           </span>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge variant={row.classification_status === 'finalized' ? 'default' : 'secondary'} className={row.classification_status === 'finalized' ? 'bg-indigo-600 hover:bg-indigo-700' : ''}>{row.classification_status}</Badge>
                            {row.sent_to_cam && <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Sent to CAM</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-[13px] text-slate-600 line-clamp-2" title={row.recovery_reason}>{row.recovery_reason || "No reason provided."}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          </Tabs>
        </Card>

      </div>
    </div>
  );
}
