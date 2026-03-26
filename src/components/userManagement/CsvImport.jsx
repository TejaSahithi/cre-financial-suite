/**
 * CsvImport v2 — per-user role assignment in review step
 * Upload → Review (with per-row role + edit) → Confirm & Send
 */
import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, Loader2, ChevronRight, Upload, Trash2, UserPlus } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import { toast } from "sonner";
import { ROLE_DEFINITIONS } from "@/lib/userPermissions";

const STEPS = ["Upload CSV", "Review & Assign", "Confirm"];

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line, idx) => {
    const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ""; });
    const email = row.email || "";
    return {
      _id: idx,
      full_name: row.full_name || row.name || "",
      email,
      phone: row.phone || row.phone_number || "",
      role: "viewer",           // default role per user
      custom_role: "",
      _valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    };
  });
}

export default function CsvImport({ orgId, currentUser, onClose, onImported }) {
  const [step, setStep] = useState(0);
  const [rows, setRows] = useState([]);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const validRows = rows.filter((r) => r._valid);
  const invalidCount = rows.filter((r) => !r._valid).length;

  const handleFile = (file) => {
    if (!file || !file.name.endsWith(".csv")) { toast.error("Please upload a .csv file"); return; }
    const reader = new FileReader();
    reader.onload = (e) => { setRows(parseCSV(e.target.result)); setStep(1); };
    reader.readAsText(file);
  };

  const updateRow = (id, field, value) =>
    setRows((prev) => prev.map((r) => r._id === id ? { ...r, [field]: value } : r));

  const removeRow = (id) => setRows((prev) => prev.filter((r) => r._id !== id));

  const bulkSetRole = (role) => setRows((prev) => prev.map((r) => ({ ...r, role })));

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
            role: row.role,
            custom_role: row.role === "custom" ? row.custom_role : undefined,
            org_id: orgId,
            onboarding_type: "invited",
          },
        });
        if (error) throw new Error(error.message);
        successCount++;
      } catch { failedEmails.push(row.email); }
    }

    await supabase.from("bulk_import_logs").insert({
      org_id: orgId, uploaded_by: currentUser?.id,
      total_count: validRows.length, success_count: successCount,
      failed_count: failedEmails.length, failed_emails: failedEmails,
    }).catch(() => {});

    setImporting(false);
    toast.success(`Imported ${successCount} user${successCount !== 1 ? "s" : ""}`);
    if (failedEmails.length) toast.warning(`${failedEmails.length} invitation(s) failed`);
    onImported();
    onClose();
  };

  return (
    <div className="space-y-5">
      {/* Step bar */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${i === step ? "text-blue-600" : i < step ? "text-emerald-600" : "text-slate-400"}`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${i < step ? "bg-emerald-100 text-emerald-600" : i === step ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-400"}`}>
                {i < step ? <Check className="w-3 h-3" /> : i + 1}
              </div>
              {s}
            </div>
            {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      {/* ── Step 0: Upload ── */}
      {step === 0 && (
        <div>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 hover:border-blue-400 hover:bg-blue-50/30"}`}
          >
            <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-700">Drop a CSV file here or click to browse</p>
            <p className="text-xs text-slate-400 mt-1">Columns: <code className="bg-slate-100 px-1 rounded">full_name, email, phone</code></p>
          </div>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
        </div>
      )}

      {/* ── Step 1: Review & Assign Role per User ── */}
      {step === 1 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-600"><span className="font-bold text-emerald-600">{validRows.length}</span> valid</span>
              {invalidCount > 0 && <span className="text-xs text-amber-600 font-semibold">{invalidCount} invalid (bad email, skipped)</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">Set all to:</span>
              {["viewer", "editor", "manager", "finance"].map((r) => (
                <button key={r} onClick={() => bulkSetRole(r)} className="text-[11px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium capitalize">{r}</button>
              ))}
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[1.2fr_1.5fr_1fr_1.4fr_auto] gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              <span>Name</span><span>Email</span><span>Phone</span><span>Role</span><span></span>
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
              {rows.filter((r) => r._valid).map((row) => (
                <div key={row._id} className="grid grid-cols-[1.2fr_1.5fr_1fr_1.4fr_auto] gap-2 items-center px-3 py-2.5">
                  <Input
                    value={row.full_name}
                    onChange={(e) => updateRow(row._id, "full_name", e.target.value)}
                    placeholder="Name"
                    className="h-7 text-xs border-0 bg-transparent px-0 focus-visible:ring-0 hover:bg-slate-50 rounded"
                  />
                  <span className="text-xs text-slate-500 truncate">{row.email}</span>
                  <Input
                    value={row.phone}
                    onChange={(e) => updateRow(row._id, "phone", e.target.value)}
                    placeholder="Phone"
                    className="h-7 text-xs border-0 bg-transparent px-0 focus-visible:ring-0 hover:bg-slate-50 rounded"
                  />
                  <div>
                    <Select value={row.role} onValueChange={(v) => updateRow(row._id, "role", v)}>
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_DEFINITIONS.filter((r) => r.value !== "org_admin").map((r) => (
                          <SelectItem key={r.value} value={r.value} className="text-xs">
                            <span className="font-semibold">{r.label}</span>
                            <span className="text-slate-400 ml-1.5">— {r.description}</span>
                          </SelectItem>
                        ))}
                        <SelectItem value="custom" className="text-xs font-semibold text-pink-600">Custom Role</SelectItem>
                      </SelectContent>
                    </Select>
                    {row.role === "custom" && (
                      <Input value={row.custom_role} onChange={(e) => updateRow(row._id, "custom_role", e.target.value)}
                        placeholder="e.g. Portfolio Analyst" className="h-6 text-[11px] mt-1" />
                    )}
                  </div>
                  <button onClick={() => removeRow(row._id)} className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-red-400 hover:bg-red-50 rounded">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => { setStep(0); setRows([]); }}>Re-upload</Button>
            <Button size="sm" className="bg-[#1a2744] hover:bg-[#243b67] gap-1.5" onClick={() => setStep(2)} disabled={validRows.length === 0}>
              <UserPlus className="w-4 h-4" />Review & Confirm ({validRows.length} user{validRows.length !== 1 ? "s" : ""})
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2: Confirm ── */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1.5fr_1.5fr_1fr] gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              <span>User</span><span>Email</span><span>Role</span>
            </div>
            <div className="max-h-52 overflow-y-auto divide-y divide-slate-100">
              {validRows.map((r) => {
                const rd = ROLE_DEFINITIONS.find((d) => d.value === r.role);
                return (
                  <div key={r._id} className="grid grid-cols-[1.5fr_1.5fr_1fr] gap-2 items-center px-3 py-2.5 text-xs">
                    <span className="font-medium text-slate-800">{r.full_name || "—"}</span>
                    <span className="text-slate-500 truncate">{r.email}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${rd?.color || "bg-slate-100 text-slate-600"}`}>
                      {r.role === "custom" ? (r.custom_role || "Custom") : rd?.label || r.role}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
            <Button onClick={handleImport} disabled={importing} className="bg-emerald-600 hover:bg-emerald-700 gap-2">
              {importing && <Loader2 className="w-4 h-4 animate-spin" />}
              Send {validRows.length} Invitation{validRows.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
