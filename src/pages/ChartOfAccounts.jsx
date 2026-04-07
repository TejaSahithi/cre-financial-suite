import React, { useState } from "react";
import { GLAccountService } from "@/services/api";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Plus, BookOpen, Pencil, Trash2, Download, Upload } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { downloadCSV } from "@/utils/index";
import BulkImportModal from "@/components/property/BulkImportModal";

const EXPENSE_CATEGORIES = [
  "property_tax","insurance","utilities","landscaping","snow_removal","parking_lot_maintenance",
  "elevator_maintenance","security","janitorial","trash_removal","fire_systems","hvac_maintenance",
  "plumbing","electrical","roof_repairs","pest_control","management_fee","administrative_fee",
  "general_repairs","lobby_maintenance","cleaning","accounting","legal_fees","capital_improvements",
  "structural_repairs","depreciation","mortgage","leasing_commissions","other"
];

const DEFAULT_GL_ACCOUNTS = [
  { code: "4000", name: "Revenue", type: "revenue", category: "Revenue" },
  { code: "4100", name: "Base Rent Revenue", type: "revenue", category: "Rental Income" },
  { code: "4200", name: "CAM Recoveries", type: "revenue", category: "Recoveries" },
  { code: "4300", name: "Percentage Rent", type: "revenue", category: "Rental Income" },
  { code: "5000", name: "Operating Expenses", type: "expense", category: "OpEx" },
  { code: "5100", name: "Property Tax", type: "expense", category: "property_tax" },
  { code: "5200", name: "Insurance", type: "expense", category: "insurance" },
  { code: "5300", name: "Utilities", type: "expense", category: "utilities" },
  { code: "5400", name: "Maintenance & Repairs", type: "expense", category: "general_repairs" },
  { code: "5500", name: "Management Fee", type: "expense", category: "management_fee" },
  { code: "5600", name: "Janitorial", type: "expense", category: "janitorial" },
  { code: "5700", name: "Landscaping", type: "expense", category: "landscaping" },
  { code: "5800", name: "Security", type: "expense", category: "security" },
  { code: "5900", name: "Administrative", type: "expense", category: "administrative_fee" },
  { code: "6000", name: "Legal & Accounting", type: "expense", category: "legal_fees" },
];

export default function ChartOfAccounts() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showDialog, setShowDialog] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({ code: "", name: "", type: "expense", category: "", description: "" });
  const queryClient = useQueryClient();

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['gl-accounts'],
    queryFn: () => GLAccountService.list('code'),
  });

  const createMutation = useMutation({
    mutationFn: (data) => GLAccountService.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['gl-accounts'] }); setShowDialog(false); },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => GLAccountService.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['gl-accounts'] }); setShowDialog(false); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => GLAccountService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gl-accounts'] }),
  });

  const seedDefaults = async () => {
    for (const acct of DEFAULT_GL_ACCOUNTS) {
      await GLAccountService.create({ ...acct, org_id: "default", is_active: true });
    }
    queryClient.invalidateQueries({ queryKey: ['gl-accounts'] });
  };

  const handleSave = () => {
    const payload = { ...form, org_id: "default", is_active: true };
    if (editItem) updateMutation.mutate({ id: editItem.id, data: payload });
    else createMutation.mutate(payload);
  };

  const openEdit = (acct) => {
    setEditItem(acct);
    setForm({ code: acct.code, name: acct.name, type: acct.type, category: acct.category || "", description: acct.description || "" });
    setShowDialog(true);
  };

  const openNew = () => {
    setEditItem(null);
    setForm({ code: "", name: "", type: "expense", category: "", description: "" });
    setShowDialog(true);
  };

  const filtered = accounts.filter(a => {
    const matchSearch = !search || a.code?.includes(search) || a.name?.toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === "all" || a.type === typeFilter;
    return matchSearch && matchType;
  });

  const revenueCount = accounts.filter(a => a.type === 'revenue').length;
  const expenseCount = accounts.filter(a => a.type === 'expense').length;

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <PageHeader icon={BookOpen} title="Chart of Accounts" subtitle={`${accounts.length} GL accounts · Map expense categories to general ledger codes`} iconColor="from-blue-500 to-blue-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(accounts, 'chart_of_accounts.csv')}><Download className="w-3.5 h-3.5 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-3.5 h-3.5 mr-1" />Import</Button>
          {accounts.length === 0 && <Button variant="outline" size="sm" onClick={seedDefaults}>Seed Defaults</Button>}
          <Button size="sm" onClick={openNew} className="bg-blue-600 hover:bg-blue-700 shadow-sm"><Plus className="w-3.5 h-3.5 mr-1" />Add Account</Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-slate-900">{accounts.length}</p><p className="text-[10px] text-slate-500 uppercase font-semibold">Total Accounts</p></CardContent></Card>
        <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-emerald-600">{revenueCount}</p><p className="text-[10px] text-slate-500 uppercase font-semibold">Revenue Accounts</p></CardContent></Card>
        <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-red-600">{expenseCount}</p><p className="text-[10px] text-slate-500 uppercase font-semibold">Expense Accounts</p></CardContent></Card>
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search by code or name..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-8 text-sm" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="revenue">Revenue</SelectItem>
            <SelectItem value="expense">Expense</SelectItem>
            <SelectItem value="asset">Asset</SelectItem>
            <SelectItem value="liability">Liability</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-slate-50">
              <TableHead className="text-[10px] w-20">CODE</TableHead>
              <TableHead className="text-[10px]">ACCOUNT NAME</TableHead>
              <TableHead className="text-[10px]">TYPE</TableHead>
              <TableHead className="text-[10px]">CATEGORY / MAPPING</TableHead>
              <TableHead className="text-[10px]">STATUS</TableHead>
              <TableHead className="text-[10px] w-20">ACTIONS</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-sm text-slate-400">{accounts.length === 0 ? 'No accounts yet. Click "Seed Defaults" to create standard CRE accounts.' : 'No matching accounts'}</TableCell></TableRow>
              ) : filtered.map(a => (
                <TableRow key={a.id} className="hover:bg-slate-50">
                  <TableCell className="font-mono font-bold text-sm text-slate-800">{a.code}</TableCell>
                  <TableCell className="text-sm font-medium">{a.name}</TableCell>
                  <TableCell><Badge className={`text-[9px] uppercase ${a.type === 'revenue' ? 'bg-emerald-100 text-emerald-700' : a.type === 'expense' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{a.type}</Badge></TableCell>
                  <TableCell className="text-xs text-slate-500">{a.category ? a.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'}</TableCell>
                  <TableCell><Badge className={a.is_active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}>{a.is_active !== false ? 'Active' : 'Inactive'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(a)}><Pencil className="w-3 h-3" /></Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => deleteMutation.mutate(a.id)}><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editItem ? 'Edit' : 'New'} GL Account</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">GL Code</Label><Input value={form.code} onChange={e => setForm({...form, code: e.target.value})} placeholder="e.g. 5100" /></div>
              <div><Label className="text-xs">Account Name</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Property Tax" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Type</Label>
                <Select value={form.type} onValueChange={v => setForm({...form, type: v})}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="revenue">Revenue</SelectItem><SelectItem value="expense">Expense</SelectItem><SelectItem value="asset">Asset</SelectItem><SelectItem value="liability">Liability</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Expense Category Mapping</Label>
                <Select value={form.category} onValueChange={v => setForm({...form, category: v})}><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>{EXPENSE_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.replace(/_/g,' ').replace(/\b\w/g,ch=>ch.toUpperCase())}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div><Label className="text-xs">Description</Label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Optional description" /></div>
          </div>
          <DialogFooter><Button onClick={handleSave} disabled={!form.code || !form.name} className="bg-blue-600 hover:bg-blue-700">{editItem ? 'Update' : 'Create'} Account</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="glAccount" 
      />
    </div>
  );
}