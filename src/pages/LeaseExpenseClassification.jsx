import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { expenseService } from "@/services/expenseService";
import useOrgQuery from "@/hooks/useOrgQuery";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { AlertTriangle, Info, CheckCircle, Upload, Plus, FileText, ArrowRightCircle } from "lucide-react";
import { createPageUrl } from "@/utils";

export default function LeaseExpenseClassification() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  return (
    <div className="flex flex-col h-full bg-background min-h-screen pb-20">
      <PageHeader
        title="Expense Recoverability"
        subtitle="Matching approved actual expenses to approved lease rules and calculate recoverability."
      >
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/expenses/add")}><Plus className="w-4 h-4 mr-2"/>Add Expense</Button>
          <Button variant="outline" size="sm" onClick={() => navigate("/expenses/import")}><Upload className="w-4 h-4 mr-2"/>Bulk Import</Button>
          <Button variant="outline" size="sm" onClick={() => navigate("/lease-expense-rules")}><FileText className="w-4 h-4 mr-2"/>Manage Lease Rules</Button>
          <Button variant="default" size="sm" onClick={() => runClassificationMutation.mutate()} disabled={runClassificationMutation.isPending || approvedActuals.length === 0 || approvedRules.length === 0}>
            Run Classification
          </Button>
          <Button variant="secondary" size="sm" onClick={handleFinalizeSelected} disabled={selectedRows.size === 0 || finalizeMutation.isPending}>
            Finalize Selected
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSendToCamSelected} disabled={selectedRows.size === 0 || sendToCamMutation.isPending}>
            <ArrowRightCircle className="w-4 h-4 mr-2"/> Send Eligible to CAM
          </Button>
        </div>
      </PageHeader>

      <div className="px-6 py-4 border-b bg-muted/20">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div>
            <label className="text-xs font-medium mb-1 block">Property</label>
            <select className="w-full text-sm border rounded p-1" value={selectedProperty} onChange={e => setSelectedProperty(e.target.value)}>
              <option value="all">All Properties</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.property_name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Building</label>
            <select className="w-full text-sm border rounded p-1" value={selectedBuilding} onChange={e => setSelectedBuilding(e.target.value)}>
              <option value="all">All Buildings</option>
              {buildings.filter(b => selectedProperty === 'all' || b.property_id === selectedProperty).map(b => <option key={b.id} value={b.id}>{b.building_name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Unit</label>
            <select className="w-full text-sm border rounded p-1" value={selectedUnit} onChange={e => setSelectedUnit(e.target.value)}>
              <option value="all">All Units</option>
              {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Lease</label>
            <select className="w-full text-sm border rounded p-1" value={selectedLease} onChange={e => setSelectedLease(e.target.value)}>
              <option value="all">All Leases</option>
              {leases.map(l => <option key={l.id} value={l.id}>{l.tenant_name || l.id}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Tenant</label>
            <select className="w-full text-sm border rounded p-1" value={selectedTenant} onChange={e => setSelectedTenant(e.target.value)}>
              <option value="all">All Tenants</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.tenant_name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Fiscal Year</label>
            <select className="w-full text-sm border rounded p-1" value={selectedYear} onChange={e => setSelectedYear(e.target.value)}>
              <option value="all">All Years</option>
              <option value="2024">2024</option>
              <option value="2025">2025</option>
              <option value="2026">2026</option>
            </select>
          </div>
        </div>
      </div>

      <div className="p-6 flex-1 space-y-6">
        
        {/* Banners */}
        {approvedActuals.length === 0 && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-md flex items-center justify-between">
            <div className="flex items-center"><AlertTriangle className="w-5 h-5 mr-3"/> No approved actual expenses found for this scope. Add/import expenses and approve them before classification.</div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate("/expenses/add")}>Add Expense</Button>
              <Button variant="outline" size="sm" onClick={() => navigate("/expenses/import")}>Bulk Import</Button>
            </div>
          </div>
        )}

        {approvedActuals.length > 0 && approvedRules.length === 0 && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-md flex items-center justify-between">
            <div className="flex items-center"><Info className="w-5 h-5 mr-3"/> No approved lease expense rules found for this scope. Approve lease expense rules before classification.</div>
            <Button variant="outline" size="sm" onClick={() => navigate("/lease-expense-rules")}>Manage Lease Rules</Button>
          </div>
        )}

        {approvedActuals.length > 0 && approvedRules.length > 0 && existingClassifications.length === 0 && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 p-4 rounded-md flex items-center justify-between">
            <div className="flex items-center"><CheckCircle className="w-5 h-5 mr-3"/> Ready to classify. Click Run Classification to match actual expenses against approved lease rules.</div>
            <Button onClick={() => runClassificationMutation.mutate()} size="sm" disabled={runClassificationMutation.isPending}>Run Classification</Button>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Actuals Loaded</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{approvedActuals.length}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Rules Loaded</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{approvedRules.length}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Matched Expenses</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{existingClassifications.length}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Recoverable Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-green-600">{currency(totals.recoverable)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Non-Recoverable Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-red-600">{currency(totals.nonRecoverable)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Conditional Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-amber-600">{currency(totals.conditional)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Excluded Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-600">{currency(totals.excluded)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">CAM-Eligible Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-blue-600">{currency(totals.camEligible)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Finalized Costs</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-indigo-600">{currency(totals.finalized)}</div></CardContent></Card>
          <Card><CardHeader className="py-3"><CardTitle className="text-xs text-muted-foreground">Needs Review</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-rose-600">{currency(totals.needsReview)}</div></CardContent></Card>
        </div>

        {/* Tabs and Table */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="flex justify-between items-center mb-4">
            <TabsList className="bg-muted">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="recoverable">Recoverable</TabsTrigger>
              <TabsTrigger value="non_recoverable">Non-Recoverable</TabsTrigger>
              <TabsTrigger value="conditional">Conditional</TabsTrigger>
              <TabsTrigger value="excluded">Excluded</TabsTrigger>
              <TabsTrigger value="needs_review">Needs Review</TabsTrigger>
              <TabsTrigger value="finalized">Finalized</TabsTrigger>
              <TabsTrigger value="sent_to_cam">Sent to CAM</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value={activeTab} className="border rounded-md shadow-sm bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-3 py-3 w-10"><input type="checkbox" onChange={e => setSelectedRows(e.target.checked ? new Set(filteredRows.map(r => r.id)) : new Set())} checked={filteredRows.length > 0 && selectedRows.size === filteredRows.length}/></th>
                    <th className="px-3 py-3">Category</th>
                    <th className="px-3 py-3">Amount</th>
                    <th className="px-3 py-3">Recoverability</th>
                    <th className="px-3 py-3">CAM Eligible</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3 w-64">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoading ? (
                    <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Loading classification data...</td></tr>
                  ) : filteredRows.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No records found for this view.</td></tr>
                  ) : filteredRows.map(row => (
                    <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-3 py-3">
                        <input type="checkbox" checked={selectedRows.has(row.id)} onChange={() => toggleRow(row.id)} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium">{row.category?.replace(/_/g, " ")}</div>
                        <div className="text-xs text-slate-500">{row.subcategory?.replace(/_/g, " ")}</div>
                      </td>
                      <td className="px-3 py-3 font-semibold text-slate-700">{currency(row.amount)}</td>
                      <td className="px-3 py-3">
                        <Badge variant={row.recoverability_result === 'recoverable' ? 'default' : row.recoverability_result === 'non_recoverable' ? 'destructive' : row.recoverability_result === 'conditional' ? 'outline' : 'secondary'}>
                          {row.recoverability_result?.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">{row.cam_eligible}</td>
                      <td className="px-3 py-3">
                        <Badge variant={row.classification_status === 'finalized' ? 'default' : 'secondary'}>{row.classification_status}</Badge>
                        {row.sent_to_cam && <Badge className="ml-1 bg-blue-100 text-blue-800 hover:bg-blue-200 border-none">CAM</Badge>}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-600 truncate max-w-xs" title={row.recovery_reason}>{row.recovery_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        </Tabs>

        {/* Debug Panel */}
        <div className="mt-12 p-4 bg-slate-900 text-green-400 font-mono text-xs rounded-md overflow-auto">
          <p className="font-bold text-white mb-2">// DEBUG OUTPUT</p>
          <pre>{JSON.stringify({
            scope,
            counts: scopeData?.summary,
          }, null, 2)}</pre>
        </div>

      </div>
    </div>
  );
}
