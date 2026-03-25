/**
 * CSV Bulk Import — 4-step guided flow
 * Step 1: Upload & parse  →  Step 2: Review  →  Step 3: Assign role  →  Step 4: Confirm & send
 */
import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Check, AlertTriangle, Loader2, ChevronRight, FileText, Users } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import { toast } from "sonner";

const STEPS = ["Upload", "Review", "Assign Role", "Confirm"];

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line) => {
    const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ""; });
    return {
      full_name: row.full_name || row.name || "",
      email: row.email || "",
      phone: row.phone || row.phone_number || "",
      _valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email || ""),
    };
  });
}

export default function CsvImport({ orgId, currentUser, onClose, onImported }) {
  const [step, setStep] = useState(0);
  const [rows, setRows] = useState([]);
  const [defaultRole, setDefaultRole] = useState("viewer");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef();

  const validRows = rows.filter((r) => r._valid);
  const invalidRows = rows.filter((r) => !r._valid);

  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result);
      setRows(parsed);
      setStep(1);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    setImporting(true);
    let successCount = 0;
    const failedEmails = [];

    for (const row of validRows) {
      try {
        const { error } = await supabase.functions.invoke("invite-user", {
          body: {
            email: row.email,
            full_name: row.full_name || undefined,
            phone: row.phone || undefined,
            role: defaultRole,
            org_id: orgId,
            onboarding_type: "invited",
          },
        });
        if (error) throw new Error(error.message);
        successCount++;
      } catch {
        failedEmails.push(row.email);
      }
    }

    // Log the bulk import
    await supabase.from("bulk_import_logs").insert({
      org_id: orgId,
      uploaded_by: currentUser?.id,
      total_count: validRows.length,
      success_count: successCount,
      failed_count: failedEmails.length,
      failed_emails: failedEmails,
    }).catch(() => {});

    setImporting(false);
    toast.success(`Imported ${successCount} user${successCount !== 1 ? "s" : ""} successfully`);
    if (failedEmails.length > 0) toast.warning(`${failedEmails.length} invitation(s) failed`);
    onImported();
    onClose();
  };

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${i === step ? "text-blue-600" : i < step ? "text-emerald-600" : "text-slate-400"}`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${i === step ? "bg-blue-100 text-blue-600" : i < step ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                {i < step ? <Check className="w-3 h-3" /> : i + 1}
              </div>
              {s}
            </div>
            {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1 — Upload */}
      {step === 0 && (
        <div>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
            className="border-2 border-dashed border-slate-300 rounded-2xl p-12 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-all"
          >
            <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-700">Drop a CSV file here</p>
            <p className="text-xs text-slate-400 mt-1">or click to browse</p>
          </div>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
          <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200">
            <p className="text-xs font-semibold text-slate-600 mb-2">Expected CSV columns (header row required):</p>
            <code className="text-[11px] text-slate-500">full_name, email, phone</code>
          </div>
        </div>
      )}

      {/* Step 2 — Review */}
      {step === 1 && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1.5 text-xs"><Check className="w-4 h-4 text-emerald-500" /><span className="font-semibold text-emerald-700">{validRows.length} valid</span></div>
            {invalidRows.length > 0 && <div className="flex items-center gap-1.5 text-xs"><AlertTriangle className="w-4 h-4 text-amber-500" /><span className="font-semibold text-amber-700">{invalidRows.length} invalid (bad email)</span></div>}
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 text-slate-500 font-semibold">Name</th>
                  <th className="text-left px-3 py-2 text-slate-500 font-semibold">Email</th>
                  <th className="text-left px-3 py-2 text-slate-500 font-semibold">Phone</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={i} className={r._valid ? "" : "bg-red-50"}>
                    <td className="px-3 py-2 text-slate-800">{r.full_name || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.email}</td>
                    <td className="px-3 py-2 text-slate-400">{r.phone || "—"}</td>
                    <td className="px-3 py-2">{r._valid ? <Check className="w-3 h-3 text-emerald-500" /> : <AlertTriangle className="w-3 h-3 text-red-400" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setStep(0)}>Re-upload</Button>
            <Button size="sm" className="bg-[#1a2744] hover:bg-[#243b67]" onClick={() => setStep(2)} disabled={validRows.length === 0}>
              Continue with {validRows.length} valid user{validRows.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — Assign Role */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Assign a default role for all <strong>{validRows.length}</strong> imported users. They will have <code className="text-[11px] bg-slate-100 px-1 rounded">status = invited</code> until they accept.</p>
          <div>
            <Label>Default Role</Label>
            <Select value={defaultRole} onValueChange={setDefaultRole}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer — Read-only access</SelectItem>
                <SelectItem value="editor">Editor — Can modify data</SelectItem>
                <SelectItem value="manager">Manager — Manage properties & leases</SelectItem>
                <SelectItem value="finance">Finance — Financial module access</SelectItem>
                <SelectItem value="auditor">Auditor — Audit & read-only finance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button className="bg-[#1a2744] hover:bg-[#243b67]" onClick={() => setStep(3)}>Preview & Confirm</Button>
        </div>
      )}

      {/* Step 4 — Confirm */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm space-y-2">
            <div className="flex justify-between"><span className="text-slate-500">Users to import:</span><span className="font-semibold">{validRows.length}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Default role:</span><Badge className="capitalize">{defaultRole.replace("_", " ")}</Badge></div>
            <div className="flex justify-between"><span className="text-slate-500">Invite emails:</span><span className="font-semibold text-emerald-600">Will be sent</span></div>
            {invalidRows.length > 0 && <div className="flex justify-between"><span className="text-slate-500">Skipped (invalid):</span><span className="font-semibold text-amber-600">{invalidRows.length}</span></div>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
            <Button onClick={handleImport} disabled={importing} className="bg-emerald-600 hover:bg-emerald-700">
              {importing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing...</> : `Import & Send ${validRows.length} Invitations`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
