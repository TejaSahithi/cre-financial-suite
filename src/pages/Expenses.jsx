import React, { useState } from "react";

import PipelineActions, { EXPENSE_ACTIONS } from "@/components/PipelineActions";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Plus, Upload, Search, Loader2, Pencil, Trash2, BookOpen, Receipt, DollarSign, TrendingDown, Layers, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl, downloadCSV } from "@/utils";
import ModuleLink from "@/components/ModuleLink";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import RoleGuard from "@/components/RoleGuard";
import AuditTrailPanel from "@/components/AuditTrailPanel";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ScopeSelector from "@/components/ScopeSelector";
import VendorSpendAnalysis from "@/components/expenses/VendorSpendAnalysis";

export default function Expenses() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: expenses = [], isLoading } = useOrgQuery("Expense");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
  const { data: vendors = [] } = useOrgQuery("Vendor");

  const getPropertyName = (pid) => properties.find(p => p.id === pid)?.name || "—";
  const getBuildingForProperty = (pid) => allBuildings.filter(b => b.property_id === pid);

  // Scope-filtered expenses
  const scopedExpenses = expenses.filter(e => {
    if (scopeProperty !== "all" && e.property_id !== scopeProperty) return false;
    return true;
  });
  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : null;

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const currentYearExpenses = scopedExpenses.filter(e => e.fiscal_year === currentYear);
  const prevYearExpenses = scopedExpenses.filter(e => e.fiscal_year === prevYear);
  const prevYearTotal = prevYearExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const currentBudget = budgets.find(b => b.budget_year === currentYear);
  const budgetedTotal = currentBudget?.total_expenses || 0;

  const classColors = { recoverable: "bg-emerald-100 text-emerald-700", non_recoverable: "bg-red-100 text-red-700", conditional: "bg-amber-100 text-amber-700" };
  
  const totals = {
    all: scopedExpenses.reduce((s, e) => s + (e.amount || 0), 0),
    recoverable: scopedExpenses.filter(e => e.classification === 'recoverable').reduce((s, e) => s + (e.amount || 0), 0),
    non_recoverable: scopedExpenses.filter(e => e.classification === 'non_recoverable').reduce((s, e) => s + (e.amount || 0), 0),
    conditional: scopedExpenses.filter(e => e.classification === 'conditional').reduce((s, e) => s + (e.amount || 0), 0),
  };

  const pieData = [
    { name: "Recoverable", value: totals.recoverable, color: "#10b981" },
    { name: "Non-Recoverable", value: totals.non_recoverable, color: "#ef4444" },
    { name: "Conditional", value: totals.conditional, color: "#f59e0b" },
  ].filter(d => d.value > 0);

  const filtered = scopedExpenses.filter(e => {
    const matchSearch = e.category?.toLowerCase().includes(search.toLowerCase()) || e.vendor?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || e.classification === filter;
    return matchSearch && matchFilter;
  });

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Receipt} title="Expense Engine" subtitle={`${scopedExpenses.length} expense records · Classification and recovery tracking`} iconColor="from-red-500 to-rose-600">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(scopedExpenses, 'expenses.csv')}><Download className="w-4 h-4 mr-1 text-slate-500" />Export</Button>
          <ModuleLink page="ChartOfAccounts"><Button variant="ghost" size="sm"><BookOpen className="w-4 h-4 mr-1" />GL Codes</Button></ModuleLink>
          <Link to={createPageUrl("BulkImport")}><Button variant="outline" size="sm"><Upload className="w-4 h-4 mr-1" />Bulk Import</Button></Link>
          <RoleGuard allowedRoles={["org_admin", "finance", "property_manager"]} mode="disable">
            <Link to={createPageUrl("AddExpense")}><Button size="sm" className="bg-gradient-to-r from-red-500 to-rose-600 shadow-sm"><Plus className="w-4 h-4 mr-1" />Add Expense</Button></Link>
          </RoleGuard>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={EXPENSE_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property to run expense compute/export actions.</div>
      )}

      <ScopeSelector properties={properties} buildings={allBuildings} units={allUnits} selectedProperty={scopeProperty} selectedBuilding={scopeBuilding} selectedUnit={scopeUnit} onPropertyChange={setScopeProperty} onBuildingChange={setScopeBuilding} onUnitChange={setScopeUnit} />

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <MetricCard label="Total Expenses" value={`$${(totals.all / 1000).toFixed(1)}K`} icon={DollarSign} color="bg-slate-100 text-slate-600" />
        <MetricCard label="Recoverable" value={`$${(totals.recoverable / 1000).toFixed(1)}K`} icon={TrendingDown} color="bg-emerald-50 text-emerald-600" sub="CAM pool eligible" />
        <MetricCard label="Non-Recoverable" value={`$${(totals.non_recoverable / 1000).toFixed(1)}K`} icon={Layers} color="bg-red-50 text-red-600" />
        <MetricCard label="Conditional" value={`$${(totals.conditional / 1000).toFixed(1)}K`} icon={Receipt} color="bg-amber-50 text-amber-600" />
        <MetricCard label={`Prior Year`} value={`$${(prevYearTotal / 1000).toFixed(1)}K`} sub={`FY ${prevYear}`} />
        <MetricCard label={`Budgeted`} value={`$${(budgetedTotal / 1000).toFixed(1)}K`} sub={`FY ${currentYear}`} trend={budgetedTotal > 0 ? parseFloat(((totals.all - budgetedTotal) / budgetedTotal * 100).toFixed(1)) : undefined} />
      </div>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Expense Classification</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                  {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2">
              {pieData.map(d => (
                <div key={d.name} className="flex items-center gap-1.5 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                  <span className="text-slate-600">{d.name} ${(d.value / 1000).toFixed(1)}K</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Expenses by Category (Recoverable)</CardTitle></CardHeader>
          <CardContent>
            {(() => {
              const catTotals = {};
              expenses.filter(e => e.classification === 'recoverable').forEach(e => {
                catTotals[e.category] = (catTotals[e.category] || 0) + (e.amount || 0);
              });
              const barData = Object.entries(catTotals).sort(([,a],[,b]) => b-a).slice(0,5).map(([cat, amt]) => ({
                name: cat.replace(/_/g, ' ').substring(0, 15), value: amt
              }));
              return (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 10 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
                    <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                    <Bar dataKey="value" fill="#1a2744" radius={[0, 4, 4, 0]} barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="expenses" className="space-y-4">
        <TabsList>
          <TabsTrigger value="expenses" className="text-xs">Expense Records</TabsTrigger>
          <TabsTrigger value="vendor_spend" className="text-xs">Vendor Spend Analysis</TabsTrigger>
          <TabsTrigger value="audit" className="text-xs">Audit Trail</TabsTrigger>
        </TabsList>

        <TabsContent value="expenses" className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 items-center flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input placeholder="Search category, vendor, property..." className="pl-9 h-9 text-sm" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="flex gap-1">
              {["all", "recoverable", "non_recoverable", "conditional"].map(f => (
                <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)} className={`text-xs capitalize ${filter === f ? 'bg-blue-600' : ''}`}>
                  {f === 'all' ? 'All' : f.replace('_', '-')}
                </Button>
              ))}
            </div>
          </div>

          <Card className="overflow-hidden border-slate-200/80">
            <Table>
              <TableHeader>
                <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                  <TableHead className="text-[10px] font-bold tracking-wider">DATE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">PROPERTY / LOCATION</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CATEGORY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">GL CODE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">VENDOR</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider text-right">AMOUNT</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CLASS</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CTRL</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">SOURCE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-12"><Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" /></TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-12 text-sm text-slate-400">No expenses found</TableCell></TableRow>
                ) : (
                  filtered.map(e => {
                    const propName = getPropertyName(e.property_id);
                    return (
                      <TableRow key={e.id} className="hover:bg-slate-50">
                        <TableCell className="text-xs whitespace-nowrap">{e.date || (e.fiscal_year ? `FY${e.fiscal_year}${e.month ? `-M${e.month}` : ''}` : '—')}</TableCell>
                        <TableCell>
                          <div className="text-xs">
                            <p className="font-medium text-slate-800 truncate max-w-[140px]">{propName}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs font-medium capitalize">{e.category?.replace(/_/g, ' ')}</TableCell>
                        <TableCell className="text-[10px] font-mono text-slate-500">{e.gl_code || '—'}</TableCell>
                        <TableCell className="text-xs">{e.vendor ? (
                          (() => {
                            const matchedVendor = vendors.find(v => v.name?.toLowerCase() === e.vendor?.toLowerCase() || v.id === e.vendor_id);
                            return matchedVendor ? (
                              <Link to={`/VendorProfile?id=${matchedVendor.id}`} className="text-blue-600 hover:underline font-medium" onClick={ev => ev.stopPropagation()}>{e.vendor}</Link>
                            ) : <span>{e.vendor}</span>;
                          })()
                        ) : '—'}</TableCell>
                        <TableCell className="text-right text-xs font-mono font-semibold tabular-nums">${(e.amount || 0).toLocaleString()}</TableCell>
                        <TableCell><Badge className={`${classColors[e.classification]} text-[8px] uppercase`}>{e.classification?.replace('_', '-')}</Badge></TableCell>
                        <TableCell>
                          <span className={`text-[9px] font-semibold ${e.is_controllable !== false ? 'text-emerald-600' : 'text-slate-400'}`}>
                            {e.is_controllable !== false ? 'CTRL' : 'NON'}
                          </span>
                        </TableCell>
                        <TableCell className="text-[10px] text-slate-400 capitalize">{e.source}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" className="text-[10px] h-6 px-1.5"><Pencil className="w-3 h-3" /></Button>
                            <Button variant="ghost" size="sm" className="text-[10px] h-6 px-1.5 text-red-500"><Trash2 className="w-3 h-3" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
          <div className="text-xs text-slate-400 text-right">{filtered.length} of {scopedExpenses.length} expenses</div>
        </TabsContent>

        <TabsContent value="vendor_spend">
          <VendorSpendAnalysis expenses={scopedExpenses} vendors={vendors} budgets={budgets} />
        </TabsContent>

        <TabsContent value="audit">
          <AuditTrailPanel entityType="Expense" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
