import React, { useState } from "react";
import { expenseService } from "@/services/expenseService";
import { leaseService } from "@/services/leaseService";
import { propertyService } from "@/services/propertyService";
import { parseCSV } from "@/services/parsingEngine";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plug, Circle, Upload, Download, Loader2, RefreshCw, Database } from "lucide-react";

const integrations = [
  { name: "QuickBooks Online", desc: "Sync expenses and revenue with QuickBooks", category: "accounting", icon: "📊", features: ["Expense import", "Revenue sync", "GL mapping"] },
  { name: "NetSuite", desc: "Enterprise ERP integration for GL sync", category: "accounting", icon: "📋", features: ["GL export", "Journal entries", "AP/AR sync"] },
  { name: "Xero", desc: "Cloud accounting platform integration", category: "accounting", icon: "📝", comingSoon: true },
  { name: "Yardi Voyager", desc: "Export/import data to Yardi property management", category: "pms", icon: "🏢", features: ["Property sync", "Lease export", "Tenant data"] },
  { name: "MRI Software", desc: "Bidirectional sync with MRI platform", category: "pms", icon: "🏗️", features: ["Property import", "Financial sync", "Report export"] },
  { name: "AppFolio", desc: "Sync property and lease data", category: "pms", icon: "📱", comingSoon: true },
  { name: "Entrata", desc: "Property management platform integration", category: "pms", icon: "🏠", comingSoon: true },
  { name: "CoStar", desc: "Market data and property comps", category: "market", icon: "📈", features: ["Market comps", "Rent benchmarks", "Vacancy rates"] },
  { name: "CPI Index Feed", desc: "Automatic CPI data for escalation calculations", category: "market", icon: "📉", features: ["CPI-U", "CPI-W", "Regional indices"] },
  { name: "Google Sheets", desc: "Import/export data to Google Sheets", category: "api", icon: "📑", features: ["Bulk import", "Report export", "Live sync"] },
];

export default function Integrations() {
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportTarget, setExportTarget] = useState(null);
  const queryClient = useQueryClient();

  const { data: expenses = [] } = useQuery({ queryKey: ['expenses-integ'], queryFn: () => expenseService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases-integ'], queryFn: () => leaseService.list() });
  const { data: properties = [] } = useQuery({ queryKey: ['props-integ'], queryFn: () => propertyService.list() });

  const handleCSVImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    try {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      let text = "";

      if (ext === "xlsx" || ext === "xls") {
        const { read, utils } = await import("xlsx");
        const buf = await file.arrayBuffer();
        const workbook = read(buf, { type: "array" });
        const firstSheet = workbook.SheetNames?.[0];
        if (!firstSheet) {
          setImporting(false);
          return;
        }
        text = utils.sheet_to_csv(workbook.Sheets[firstSheet], { blankrows: false });
      } else {
        text = await file.text();
      }

      const { rows: items } = parseCSV(text);

      if (items.length > 0) {
        await expenseService.bulkCreate(items.map(item => ({
          date: item.date || null,
          category: item.category || item.expense_category || "",
          amount: parseFloat(String(item.amount || item.total || item.cost || 0).replace(/[$,]/g, "")) || 0,
          vendor: item.vendor || "",
          description: item.description || "",
          classification: item.classification || "recoverable",
          property_id: properties[0]?.id || null,
          source: "import",
          fiscal_year: item.date ? new Date(item.date).getFullYear() || new Date().getFullYear() : new Date().getFullYear(),
        })));
        queryClient.invalidateQueries({ queryKey: ["expenses"] });
      }
    } catch (err) {
      console.error("[Integrations] CSV import error:", err);
    }
    setImporting(false);
    setShowImport(false);
  };

  const downloadCSV = (entityName, data) => {
    if (!data.length) return;
    const headers = Object.keys(data[0]).filter(k => k !== 'id' && !k.startsWith('created_') && !k.startsWith('updated_'));
    const csv = [headers.join(','), ...data.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${entityName}_export.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Integrations</h1>
          <p className="text-sm text-slate-500">Connect with accounting, PMS, and market data platforms</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowImport(true)}><Upload className="w-4 h-4 mr-2" />Import Data</Button>
          <Button variant="outline" onClick={() => setShowExport(true)}><Download className="w-4 h-4 mr-2" />Export Data</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Data Sources", value: 3, icon: Database, color: "bg-emerald-50 text-emerald-600", sub: "CSV, Excel, PDF" },
          { label: "Platforms", value: integrations.filter(i => !i.comingSoon).length, icon: Plug, color: "bg-blue-50 text-blue-600", sub: "Available" },
          { label: "Coming Soon", value: integrations.filter(i => i.comingSoon).length, icon: Circle, color: "bg-slate-50 text-slate-600", sub: "Planned" },
          { label: "Automations", value: 3, icon: RefreshCw, color: "bg-purple-50 text-purple-600", sub: "Active event triggers" },
        ].map((s, i) => (
          <Card key={i}><CardContent className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div><p className="text-[10px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-xl font-bold">{s.value}</p><p className="text-[10px] text-slate-400">{s.sub}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {/* Event Pipeline */}
      <Card className="bg-gradient-to-r from-slate-900 to-slate-800 text-white">
        <CardContent className="p-6">
          <h3 className="text-base font-bold mb-3">Event-Driven Pipeline — Active</h3>
          <div className="flex flex-wrap gap-3">
            {[
              { from: "ExpenseAdded", to: "VarianceRecalculated → NotificationTriggered", active: true },
              { from: "LeaseCreated/Updated", to: "ExpiryCheck → AuditLogged → BudgetNotified", active: true },
              { from: "BudgetStatusChanged", to: "ApprovalNotified → AuditLogged", active: true },
            ].map((e, i) => (
              <div key={i} className="flex items-center gap-2 bg-white/10 rounded-lg px-4 py-2.5">
                <Badge className="bg-emerald-500/20 text-emerald-300 text-[10px]">ACTIVE</Badge>
                <span className="text-xs text-white/80">{e.from}</span>
                <span className="text-white/40">→</span>
                <span className="text-xs text-white/60">{e.to}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="accounting">Accounting</TabsTrigger>
          <TabsTrigger value="pms">Property Mgmt</TabsTrigger>
          <TabsTrigger value="market">Market Data</TabsTrigger>
          <TabsTrigger value="api">API & Sheets</TabsTrigger>
        </TabsList>

        {["all", "accounting", "pms", "market", "api"].map(tab => (
          <TabsContent key={tab} value={tab} className="mt-4">
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {integrations.filter(i => tab === "all" || i.category === tab).map((integ, i) => (
                <Card key={i} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3 mb-3">
                      <span className="text-2xl">{integ.icon}</span>
                      <div className="flex-1">
                        <p className="font-semibold text-slate-900 text-sm">{integ.name}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{integ.desc}</p>
                      </div>
                    </div>
                    {integ.features && (
                      <div className="flex flex-wrap gap-1 mb-3">
                        {integ.features.map(f => (
                          <Badge key={f} variant="outline" className="text-[9px] text-slate-500">{f}</Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <Badge className={integ.comingSoon ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-700'}>
                        {integ.comingSoon ? 'Coming Soon' : 'Available'}
                      </Badge>
                      {!integ.comingSoon && (
                        <Button size="sm" className="text-xs bg-blue-600 hover:bg-blue-700">
                          <Plug className="w-3 h-3 mr-1" />Connect
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Import Dialog */}
      <Dialog open={showImport} onOpenChange={setShowImport}>
        <DialogContent>
          <DialogHeader><DialogTitle>Import Data</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">Upload a CSV or Excel file to import expenses, leases, or property data.</p>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center">
              {importing ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  <span className="text-sm text-slate-500">Processing file...</span>
                </div>
              ) : (
                <label className="cursor-pointer">
                  <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleCSVImport} />
                  <Upload className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-600 font-medium">Click to upload CSV or Excel</p>
                  <p className="text-xs text-slate-400 mt-1">System will auto-detect expense data and import</p>
                </label>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExport} onOpenChange={setShowExport}>
        <DialogContent>
          <DialogHeader><DialogTitle>Export Data</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Download your data as CSV files for use in accounting systems or spreadsheets.</p>
            {[
              { label: "Properties", count: properties.length, data: properties, entity: "properties" },
              { label: "Leases", count: leases.length, data: leases, entity: "leases" },
              { label: "Expenses", count: expenses.length, data: expenses, entity: "expenses" },
            ].map(exp => (
              <div key={exp.entity} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">{exp.label}</p>
                  <p className="text-xs text-slate-400">{exp.count} records</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => downloadCSV(exp.entity, exp.data)} disabled={exp.count === 0}>
                  <Download className="w-3 h-3 mr-1" />CSV
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
