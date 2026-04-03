import React, { useState } from "react";
import { documentService } from "@/services/documentService";
import { supabase } from "@/services/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Upload, FolderOpen, FileText, Receipt, BarChart3, Loader2, Trash2, ExternalLink } from "lucide-react";

export default function Documents() {
  const [search, setSearch] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({ name: "", type: "other", description: "", property_id: "", tenant_name: "", vendor_name: "" });
  const [tagFilter, setTagFilter] = useState("all");
  const queryClient = useQueryClient();
  const { orgId } = useOrgId();

  const { data: documents = [] } = useOrgQuery("Document");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: vendors = [] } = useOrgQuery("Vendor");

  // Combine uploaded documents with lease PDFs
  const leaseDocuments = leases.filter(l => l.pdf_url).map(l => ({
    id: `lease-${l.id}`,
    name: `Lease - ${l.tenant_name}`,
    type: "lease",
    description: `${l.lease_type} lease · ${l.start_date} - ${l.end_date}`,
    file_url: l.pdf_url,
    created_date: l.created_date,
    source: "lease",
  }));

  const allDocs = [...documents, ...leaseDocuments];

  const filtered = allDocs.filter(d => {
    const matchSearch = !search || d.name?.toLowerCase().includes(search.toLowerCase()) || d.description?.toLowerCase().includes(search.toLowerCase());
    const matchTag = tagFilter === "all" || d.type === tagFilter;
    return matchSearch && matchTag;
  });

  const typeColors = {
    lease: "bg-blue-100 text-blue-700",
    invoice: "bg-emerald-100 text-emerald-700",
    receipt: "bg-purple-100 text-purple-700",
    report: "bg-amber-100 text-amber-700",
    contract: "bg-indigo-100 text-indigo-700",
    other: "bg-slate-100 text-slate-700",
  };

  const countByType = (type) => allDocs.filter(d => d.type === type).length;

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    let file_url = "";
    try {
      const fileName = `documents/${Date.now()}-${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, file, { upsert: true });
      if (!uploadError && uploadData) {
        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        file_url = urlData?.publicUrl || "";
      } else if (uploadError) {
        // Storage bucket missing or unavailable — fall back to local blob URL
        file_url = URL.createObjectURL(file);
      }
    } catch {
      file_url = URL.createObjectURL(file);
    }
    await documentService.create({
      ...uploadForm,
      name: uploadForm.name || file.name,
      file_url,
      org_id: orgId || "",
    });
    queryClient.invalidateQueries({ queryKey: ['Document', orgId] });
    setUploading(false);
    setShowUpload(false);
    setUploadForm({ name: "", type: "other", description: "", property_id: "", tenant_name: "", vendor_name: "" });
  };

  const deleteMutation = useMutation({
    mutationFn: (id) => documentService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['Document', orgId] }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Documents</h1>
          <p className="text-sm text-slate-500">Manage leases, invoices, receipts, and reports</p>
        </div>
        <Button onClick={() => setShowUpload(true)} className="bg-blue-600 hover:bg-blue-700">
          <Upload className="w-4 h-4 mr-2" />Upload Document
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Lease PDFs", value: countByType("lease"), icon: FileText, color: "bg-blue-50 text-blue-600" },
          { label: "Invoices", value: countByType("invoice"), icon: Receipt, color: "bg-emerald-50 text-emerald-600" },
          { label: "Contracts", value: countByType("contract"), icon: FolderOpen, color: "bg-purple-50 text-purple-600" },
          { label: "Reports", value: countByType("report"), icon: BarChart3, color: "bg-amber-50 text-amber-600" },
        ].map((s, i) => (
          <Card key={i}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
              <div><p className="text-[10px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-xl font-bold">{s.value}</p></div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search documents..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger className="w-36 h-9 text-xs"><SelectValue placeholder="All Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {["lease","invoice","receipt","report","contract","cam_report","vendor_invoice","other"].map(t => (
              <SelectItem key={t} value={t}>{t.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">DOCUMENT</TableHead>
                <TableHead className="text-[11px]">TYPE</TableHead>
                <TableHead className="text-[11px]">DESCRIPTION</TableHead>
                <TableHead className="text-[11px]">DATE</TableHead>
                <TableHead className="text-[11px]">ACTIONS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-slate-400 text-sm">
                    {search ? 'No documents match your search' : 'No documents uploaded yet. Upload your first document to get started.'}
                  </TableCell>
                </TableRow>
              ) : filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <span className="font-medium text-sm">{d.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={`${typeColors[d.type] || typeColors.other} text-[10px] uppercase`}>
                      {d.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-500 max-w-[200px] truncate">{d.description || '—'}</TableCell>
                  <TableCell className="text-sm text-slate-500">{d.created_date?.substring(0, 10)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {d.file_url && (
                        <a href={d.file_url} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="sm" className="text-xs h-7 px-2 gap-1">
                            <ExternalLink className="w-3 h-3" />View
                          </Button>
                        </a>
                      )}
                      {!d.source && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 px-2 text-red-500"
                          onClick={() => deleteMutation.mutate(d.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent>
          <DialogHeader><DialogTitle>Upload Document</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Document Name</Label>
              <Input value={uploadForm.name} onChange={e => setUploadForm({ ...uploadForm, name: e.target.value })} placeholder="e.g. Q1 2026 Expense Report" />
            </div>
            <div>
              <Label>Document Type</Label>
              <Select value={uploadForm.type} onValueChange={v => setUploadForm({ ...uploadForm, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lease">Lease</SelectItem>
                  <SelectItem value="invoice">Invoice</SelectItem>
                  <SelectItem value="receipt">Receipt</SelectItem>
                  <SelectItem value="report">Report</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input value={uploadForm.description} onChange={e => setUploadForm({ ...uploadForm, description: e.target.value })} placeholder="Brief description" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Property</Label>
                <Select value={uploadForm.property_id} onValueChange={v => setUploadForm({ ...uploadForm, property_id: v })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>None</SelectItem>
                    {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tenant</Label>
                <Input value={uploadForm.tenant_name} onChange={e => setUploadForm({ ...uploadForm, tenant_name: e.target.value })} placeholder="Tenant name" />
              </div>
              <div>
                <Label>Vendor</Label>
                <Select value={uploadForm.vendor_name} onValueChange={v => setUploadForm({ ...uploadForm, vendor_name: v })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>None</SelectItem>
                    {vendors.map(v => <SelectItem key={v.id} value={v.name}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center">
              {uploading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  <span className="text-sm text-slate-500">Uploading...</span>
                </div>
              ) : (
                <label className="cursor-pointer">
                  <input type="file" className="hidden" onChange={handleUpload} />
                  <Upload className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-600 font-medium">Click to browse files</p>
                  <p className="text-xs text-slate-400 mt-1">PDF, CSV, Excel, Images</p>
                </label>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}