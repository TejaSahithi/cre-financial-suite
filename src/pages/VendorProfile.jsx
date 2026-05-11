import React, { useState } from "react";
import { documentService } from "@/services/documentService";
import { expenseService } from "@/services/expenseService";
import { propertyService } from "@/services/propertyService";
import { vendorService } from "@/services/vendorService";
import { supabase } from "@/services/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, TrendingUp, ArrowUpRight, ArrowDownRight, FileText, Search, Loader2, Upload } from "lucide-react";
import {  Link , useLocation } from 'react-router-dom';
import { createPageUrl } from "@/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

export default function VendorProfile() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const vendorId = urlParams.get("id");
  const [expSearch, setExpSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const queryClient = useQueryClient();

  const { data: vendor, isLoading: vendorLoading } = useQuery({
    queryKey: ['vendor', vendorId],
    queryFn: async () => {
      const vendors = await vendorService.list();
      return vendors.find(v => v.id === vendorId);
    },
    enabled: !!vendorId,
  });

  const { data: expenses = [] } = useQuery({ queryKey: ['expenses-vp'], queryFn: () => expenseService.list('-created_date') });
  const { data: properties = [] } = useQuery({ queryKey: ['properties-vp'], queryFn: () => propertyService.list() });
  const { data: documents = [] } = useQuery({ queryKey: ['docs-vp'], queryFn: () => documentService.list() });

  const createDocMutation = useMutation({
    mutationFn: (d) => documentService.create(d),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['docs-vp'] }),
  });

  if (vendorLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  if (!vendor) return <div className="p-6"><p className="text-slate-500">Vendor not found.</p><Link to={createPageUrl("Vendors")}><Button variant="outline" className="mt-4"><ArrowLeft className="w-4 h-4 mr-1" />Back to Vendors</Button></Link></div>;

  const vendorExpenses = expenses.filter(e => e.vendor?.toLowerCase() === vendor.name?.toLowerCase() || e.vendor_id === vendor.id);
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const thisYearExp = vendorExpenses.filter(e => e.fiscal_year === currentYear);
  const lastYearExp = vendorExpenses.filter(e => e.fiscal_year === prevYear);
  const thisYearTotal = thisYearExp.reduce((s, e) => s + (e.amount || 0), 0);
  const lastYearTotal = lastYearExp.reduce((s, e) => s + (e.amount || 0), 0);
  const totalSpend = vendorExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const yoyChange = lastYearTotal > 0 ? ((thisYearTotal - lastYearTotal) / lastYearTotal * 100) : null;

  const getPropertyName = (pid) => properties.find(p => p.id === pid)?.name || "—";

  // Category breakdown
  const catBreakdown = {};
  vendorExpenses.forEach(e => { catBreakdown[e.category] = (catBreakdown[e.category] || 0) + (e.amount || 0); });
  const catData = Object.entries(catBreakdown).sort(([,a],[,b]) => b - a).map(([cat, amt]) => ({ name: cat.replace(/_/g, ' '), value: amt }));
  const catColors = ["#0d9488", "#6366f1", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#8b5cf6", "#14b8a6"];

  // Monthly trend
  const monthlyMap = {};
  thisYearExp.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) monthlyMap[m] = (monthlyMap[m] || 0) + (e.amount || 0);
  });
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthlyData = Array.from({length: 12}, (_, i) => ({ month: monthNames[i], amount: monthlyMap[i + 1] || 0 }));

  // Properties served
  const propIds = [...new Set(vendorExpenses.map(e => e.property_id).filter(Boolean))];

  // Insights
  const insights = [];
  if (yoyChange !== null) {
    if (yoyChange > 0) {
      const topCat = catData[0];
      insights.push({ type: "warning", text: `Spend increased by ${yoyChange.toFixed(0)}% YoY${topCat ? `, driven primarily by ${topCat.name} costs ($${topCat.value.toLocaleString()})` : ''}` });
    } else {
      insights.push({ type: "success", text: `Spend decreased by ${Math.abs(yoyChange).toFixed(0)}% compared to last year` });
    }
  }
  if (propIds.length > 3) insights.push({ type: "info", text: `This vendor serves ${propIds.length} properties — consider negotiating volume discounts` });
  if (thisYearExp.length > 0 && thisYearTotal / thisYearExp.length > 5000) insights.push({ type: "info", text: `Average transaction is $${(thisYearTotal / thisYearExp.length).toLocaleString()} — review for cost optimization` });
  const peakMonth = monthlyData.reduce((max, m) => m.amount > max.amount ? m : max, { amount: 0 });
  if (peakMonth.amount > 0) insights.push({ type: "info", text: `Peak spending month: ${peakMonth.month} ($${peakMonth.amount.toLocaleString()})` });

  // Vendor documents
  const vendorDocs = documents.filter((d) => {
    const normalizedVendor = String(vendor.name || '').trim().toLowerCase();
    const normalizedDocVendor = String(d.vendor_name || '').trim().toLowerCase();
    const normalizedComments = String(d.comments || d.description || '').trim().toLowerCase();
    return normalizedDocVendor === normalizedVendor || normalizedComments.includes(normalizedVendor);
  });

  const filteredExpenses = vendorExpenses.filter(e => {
    if (!expSearch) return true;
    return e.category?.toLowerCase().includes(expSearch.toLowerCase()) || getPropertyName(e.property_id)?.toLowerCase().includes(expSearch.toLowerCase());
  });

  const handleDocUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    let file_url = "";
    try {
      const fileName = `vendor-docs/${Date.now()}-${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('financial-uploads')
        .upload(fileName, file, { upsert: true });
      if (!uploadError && uploadData) {
        const { data: urlData } = supabase.storage.from('financial-uploads').getPublicUrl(fileName);
        file_url = urlData?.publicUrl || "";
      } else {
        file_url = URL.createObjectURL(file);
      }
    } catch {
      file_url = URL.createObjectURL(file);
    }
    await createDocMutation.mutateAsync({
      org_id: vendor.org_id || "default",
      vendor_name: vendor.name,
      name: file.name,
      type: "vendor_invoice",
      file_url,
      comments: `Vendor: ${vendor.name}`,
    });
    setUploading(false);
  };

  const statusColors = { active: "bg-emerald-100 text-emerald-700", inactive: "bg-slate-100 text-slate-600", pending: "bg-amber-100 text-amber-700" };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to={createPageUrl("Vendors")}><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />Vendors</Button></Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white font-bold text-xl shadow-lg">
            {vendor.name?.charAt(0)?.toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{vendor.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              {vendor.company && <span className="text-sm text-slate-500">{vendor.company}</span>}
              <Badge className={`${statusColors[vendor.status]} text-[9px] uppercase`}>{vendor.status}</Badge>
              <Badge variant="outline" className="text-[9px] capitalize">{vendor.category?.replace(/_/g, ' ')}</Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Vendor Details + Financial Summary */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Vendor Details</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Contact</span><span className="font-medium">{vendor.contact_name || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Email</span><span className="font-medium text-blue-600">{vendor.contact_email || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Phone</span><span className="font-medium">{vendor.contact_phone || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Tax ID</span><span className="font-medium">{vendor.tax_id || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Terms</span><span className="font-medium uppercase">{vendor.payment_terms?.replace(/_/g, ' ') || '—'}</span></div>
            </div>
            {propIds.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Properties Served ({propIds.length})</p>
                <div className="flex flex-wrap gap-1">
                  {propIds.map(pid => <Badge key={pid} variant="outline" className="text-[9px]">{getPropertyName(pid)}</Badge>)}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Financial Summary</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="bg-slate-50 rounded-xl p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Total Spend</p>
                <p className="text-xl font-bold">${totalSpend.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{vendorExpenses.length} transactions</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">This Year ({currentYear})</p>
                <p className="text-xl font-bold">${thisYearTotal.toLocaleString()}</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Last Year ({prevYear})</p>
                <p className="text-xl font-bold text-slate-500">${lastYearTotal.toLocaleString()}</p>
              </div>
              <div className={`rounded-xl p-3 ${yoyChange !== null && yoyChange > 0 ? 'bg-red-50' : 'bg-emerald-50'}`}>
                <p className="text-[9px] text-slate-400 uppercase font-bold">YoY Change</p>
                <div className="flex items-center gap-1">
                  {yoyChange !== null ? (
                    <>
                      {yoyChange > 0 ? <ArrowUpRight className="w-4 h-4 text-red-600" /> : <ArrowDownRight className="w-4 h-4 text-emerald-600" />}
                      <p className={`text-xl font-bold ${yoyChange > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{yoyChange > 0 ? '+' : ''}{yoyChange.toFixed(1)}%</p>
                    </>
                  ) : <p className="text-xl font-bold text-slate-400">—</p>}
                </div>
              </div>
            </div>
            {/* Monthly trend chart */}
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={monthlyData}>
                <XAxis dataKey="month" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
                <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                <Bar dataKey="amount" fill="#7c3aed" radius={[4, 4, 0, 0]} barSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <Card className="border-violet-200 bg-gradient-to-r from-violet-50/50 to-purple-50/30">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="w-4 h-4 text-violet-600" />AI Insights</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {insights.map((ins, i) => (
                <div key={i} className={`px-3 py-2 rounded-lg text-xs font-medium border ${
                  ins.type === 'warning' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                  ins.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                  'bg-blue-50 text-blue-800 border-blue-200'
                }`}>
                  {ins.text}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="expenses" className="space-y-4">
        <TabsList>
          <TabsTrigger value="expenses" className="text-xs">Expense Breakdown</TabsTrigger>
          <TabsTrigger value="categories" className="text-xs">Category Analysis</TabsTrigger>
          <TabsTrigger value="documents" className="text-xs">Documents ({vendorDocs.length})</TabsTrigger>
        </TabsList>

        {/* Expense Breakdown Tab */}
        <TabsContent value="expenses" className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input placeholder="Search expenses..." className="pl-9 h-9 text-sm" value={expSearch} onChange={e => setExpSearch(e.target.value)} />
          </div>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[10px] font-bold">DATE</TableHead>
                  <TableHead className="text-[10px] font-bold">PROPERTY</TableHead>
                  <TableHead className="text-[10px] font-bold">CATEGORY</TableHead>
                  <TableHead className="text-[10px] font-bold">CLASS</TableHead>
                  <TableHead className="text-[10px] font-bold text-right">AMOUNT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredExpenses.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-sm text-slate-400">No expenses found</TableCell></TableRow>
                ) : filteredExpenses.map(e => (
                  <TableRow key={e.id} className="hover:bg-slate-50">
                    <TableCell className="text-xs">{e.date || `FY${e.fiscal_year || ''}${e.month ? `-M${e.month}` : ''}`}</TableCell>
                    <TableCell className="text-xs font-medium">{getPropertyName(e.property_id)}</TableCell>
                    <TableCell className="text-xs capitalize">{e.category?.replace(/_/g, ' ')}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[8px] uppercase">{e.classification?.replace('_', '-')}</Badge></TableCell>
                    <TableCell className="text-right text-xs font-mono font-semibold">${(e.amount || 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <p className="text-[10px] text-slate-400 text-right">{filteredExpenses.length} expense records</p>
        </TabsContent>

        {/* Category Analysis Tab */}
        <TabsContent value="categories">
          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Spend by Category</CardTitle></CardHeader>
              <CardContent>
                {catData.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={catData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value">
                          {catData.map((_, i) => <Cell key={i} fill={catColors[i % catColors.length]} />)}
                        </Pie>
                        <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap gap-2 mt-2 justify-center">
                      {catData.map((d, i) => (
                        <div key={d.name} className="flex items-center gap-1 text-[10px]">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: catColors[i % catColors.length] }} />
                          <span className="capitalize text-slate-600">{d.name}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <p className="text-sm text-slate-400 text-center py-8">No category data</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Category Breakdown</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {catData.map((d, i) => (
                  <div key={d.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: catColors[i % catColors.length] }} />
                      <span className="text-xs capitalize">{d.name}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-mono font-semibold">${d.value.toLocaleString()}</span>
                      <span className="text-[10px] text-slate-400 ml-2">{totalSpend > 0 ? `${(d.value / totalSpend * 100).toFixed(0)}%` : ''}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents" className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-sm text-slate-500">{vendorDocs.length} documents</p>
            <label>
              <Button variant="outline" size="sm" className="cursor-pointer" asChild>
                <span><Upload className="w-3.5 h-3.5 mr-1" />{uploading ? 'Uploading...' : 'Upload Document'}</span>
              </Button>
              <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.xlsx,.csv" onChange={handleDocUpload} />
            </label>
          </div>
          {vendorDocs.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-sm text-slate-400">No documents uploaded for this vendor</CardContent></Card>
          ) : (
            <div className="space-y-2">
              {vendorDocs.map(d => (
                <Card key={d.id} className="hover:bg-slate-50 transition-colors">
                  <CardContent className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center"><FileText className="w-4 h-4 text-violet-600" /></div>
                      <div>
                        <p className="text-sm font-medium">{d.name}</p>
                        <p className="text-[10px] text-slate-400">{d.type?.replace(/_/g, ' ')} · {new Date(d.created_date).toLocaleDateString()}</p>
                      </div>
                    </div>
                    {d.file_url && <a href={d.file_url} target="_blank" rel="noopener noreferrer"><Button variant="ghost" size="sm" className="text-xs">View</Button></a>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
