/**
 * CsvImport v2 — per-user role assignment in review step
 * Upload → Review (with per-row role + edit) → Confirm & Send
 */
import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, ChevronRight, ChevronDown, Upload, Trash2, UserPlus, Settings, AlertTriangle } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import { toast } from "sonner";
import { ROLE_DEFINITIONS, parseRoles, getRoleDefaultModulePerms } from "@/lib/userPermissions";
import { AccessPanel } from "@/components/userManagement/AccessPanel";

const STEPS = ["Upload CSV", "Review & Assign", "Confirm"];

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  
  // Normalize headers: lower case, remove spaces, remove quotes
  const rawHeaders = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  
  return lines.slice(1).map((line, idx) => {
    const vals = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    rawHeaders.forEach((h, i) => { row[h] = vals[i] || ""; });
    
    // Header variants mapping
    const email = row.email || row.email_address || row["email address"] || "";
    const fullName = row.full_name || row["full name"] || row.name || row.customer_name || "";
    const phone = row.phone || row.phone_number || row["phone number"] || row.mobile || "";
    const roleString = row.role || row.roles || "viewer";

    return {
      _id: idx,
      full_name: fullName,
      email,
      phone,
      role: roleString,
      custom_role: "",
      module_permissions: null,
      page_permissions: null,
      _valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    };
  });
}

export default function CsvImport({ orgId, currentUser, onClose, onImported }) {
  const [step, setStep] = useState(0);
  const [rows, setRows] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [accessOverrideId, setAccessOverrideId] = useState(null);
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

  const bulkSetRole = (role) => setRows((prev) => prev.map((r) => {
    let roles = parseRoles(r.role);
    if (!roles.includes(role)) roles = [...roles, role];
    return { ...r, role: roles.join(',') };
  }));

  const handleRoleToggle = (id, val, checked) => {
    setRows(prev => prev.map(r => {
      if (r._id !== id) return r;
      let roles = parseRoles(r.role);
      let next = checked === true 
        ? (roles.includes(val) ? roles : [...roles, val]) 
        : roles.filter(x => x !== val);
      return { ...r, role: next.join(',') };
    }));
  };
  const handleImport = async () => {
    setImportProgress({ current: 0, total: validRows.length });
    let successCount = 0;
    const failedEmails = [];
    for (const [idx, row] of validRows.entries()) {
      try {
        setImportProgress({ current: idx + 1, total: validRows.length });
        const { data, error } = await supabase.functions.invoke("invite-user", {
          body: {
            email: row.email,
            full_name: row.full_name || row.name || undefined,
            phone: row.phone || undefined,
            role: row.role || "viewer",
            custom_role: parseRoles(row.role || "viewer").includes("custom") ? row.custom_role : undefined,
            org_id: orgId,
            module_permissions: row.module_permissions || getRoleDefaultModulePerms(row.role || "viewer"),
            page_permissions: row.page_permissions || {},
          },
        });
        if (error) {
          console.error(`[CsvImport] Invite failed for ${row.email}:`, error);
          throw error;
        }
        if (data?.error) {
           console.error(`[CsvImport] Invite error from function for ${row.email}:`, data.error);
           throw new Error(data.error);
        }
        successCount++;
      } catch (err) { 
        console.error(`[CsvImport] Exception during invite for ${row.email}:`, err);
        failedEmails.push(row.email); 
      }
    }

    const logEntry = {
      org_id: orgId,
      uploaded_by: currentUser?.id,
      total_count: validRows.length,
      success_count: successCount,
      failed_count: failedEmails.length,
      failed_emails: failedEmails,
    };

    const { error: logErr } = await supabase.from("bulk_import_logs").insert(logEntry);
    if (logErr) console.error("[CsvImport] Failed to log import results:", logErr);

    setImporting(false);
    
    if (successCount > 0) {
      toast.success(`Imported ${successCount} user${successCount !== 1 ? "s" : ""}`);
      onImported();
      onClose();
    } else if (failedEmails.length > 0) {
      toast.error(`Fail to import any users. Checked logs.`);
    } else {
      toast.info("No valid users to import.");
    }
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
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-slate-500 font-medium bg-slate-100 px-2 py-0.5 rounded-full">
                <span className="text-emerald-600 font-bold">{validRows.length}</span> Valid
              </span>
              {invalidCount > 0 && (
                <span className="text-[11px] text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {invalidCount} Invalid/Skipped
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 uppercase font-bold tracking-tight mr-1">Quick assign role:</span>
              {["viewer", "editor", "manager", "finance"].map((r) => (
                <button key={r} onClick={() => bulkSetRole(r)} className="text-[10px] px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold capitalize flex items-center gap-1.5 transition-colors">
                  <span className={`w-1.5 h-1.5 rounded-full ${ROLE_DEFINITIONS.find(d => d.value === r)?.color.replace("text-", "bg-").split(" ")[0]}`}></span>
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
            {/* Table Header */}
            <div className="grid grid-cols-[1.28fr_1.5fr_1fr_1.4fr_auto] gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              <span>Member Info</span>
              <span>Email Address</span>
              <span>Phone</span>
              <span>Roles & Access</span>
              <span className="w-16"></span>
            </div>

            {/* Table Body */}
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
              {rows.map((row) => (
                <div key={row._id} className={`grid grid-cols-[1.28fr_1.5fr_1fr_1.4fr_auto] gap-2 items-center px-3 py-2.5 transition-colors ${!row._valid ? 'bg-amber-50/20 opacity-70' : 'hover:bg-slate-50/50'}`}>
                  {/* Name */}
                  <div className="flex items-center gap-2 min-w-0">
                    {!row._valid && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                    <Input
                      value={row.full_name}
                      onChange={(e) => updateRow(row._id, "full_name", e.target.value)}
                      placeholder="Enter name..."
                      className="h-8 text-xs border-0 bg-transparent px-0 focus-visible:ring-0 font-medium text-slate-700 hover:bg-slate-100/50 rounded-md transition-colors"
                    />
                  </div>

                  {/* Email */}
                  <span className="text-xs text-slate-500 truncate font-medium" title={row.email}>{row.email}</span>

                  {/* Phone */}
                  <Input
                    value={row.phone}
                    onChange={(e) => updateRow(row._id, "phone", e.target.value)}
                    placeholder="—"
                    className="h-8 text-xs border-0 bg-transparent px-0 focus-visible:ring-0 text-slate-500 hover:bg-slate-100/50 rounded-md transition-colors"
                  />

                  {/* Roles Selector */}
                  <div className="space-y-1">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className={`h-8 text-xs w-full justify-between items-center text-left font-medium px-2.5 ${!row.role ? 'text-slate-400 border-dashed border-slate-300' : 'text-slate-700 border-slate-200'}`}>
                          <span className="truncate flex-1">
                             {!row.role ? "Select Roles" : parseRoles(row.role).map(r => ROLE_DEFINITIONS.find(d => d.value === r)?.label || r).join(', ')}
                          </span>
                          <ChevronDown className="w-3 h-3 opacity-30 shrink-0 ml-1.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-2 shadow-xl border-slate-200" align="start">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-slate-400 uppercase px-2 py-1 tracking-tight">Assign Permissions</p>
                          {ROLE_DEFINITIONS.filter((r) => r.value !== "org_admin").map((r) => (
                            <div key={r.value} className="flex flex-row items-center space-x-2.5 px-2 py-1.5 hover:bg-blue-50/50 rounded-md transition-colors cursor-pointer group" 
                                 onClick={(e) => { e.preventDefault(); handleRoleToggle(row._id, r.value, !parseRoles(row.role).includes(r.value)); }}>
                              <Checkbox id={`role-${row._id}-${r.value}`} checked={parseRoles(row.role).includes(r.value)} onCheckedChange={(c) => handleRoleToggle(row._id, r.value, c)} />
                              <Label htmlFor={`role-${row._id}-${r.value}`} className="text-xs cursor-pointer flex-1 flex items-center justify-between">
                                <span className="flex items-center gap-2">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.color.replace("text-", "bg-").split(" ")[0]}`} />
                                  <span className="font-medium text-slate-700">{r.label}</span>
                                </span>
                              </Label>
                            </div>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>

                    {parseRoles(row.role).includes("custom") && (
                      <Input 
                        value={row.custom_role} 
                        onChange={(e) => updateRow(row._id, "custom_role", e.target.value)}
                        placeholder="e.g. Portfolio Manager" 
                        className="h-7 text-[10px] border-slate-200 focus:border-blue-300 transition-colors" 
                      />
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 w-16 justify-end">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setAccessOverrideId(row._id)} 
                      title="Advanced Permissions" 
                      className={`h-8 w-8 p-0 rounded-lg transition-colors ${row.module_permissions !== null ? "bg-amber-100 text-amber-600 hover:bg-amber-200" : "text-slate-300 hover:text-blue-600 hover:bg-blue-50"}`}
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => removeRow(row._id)} 
                      title="Remove Member" 
                      className="h-8 w-8 p-0 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 mt-4 pt-2 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => { setStep(0); setRows([]); }} className="text-slate-500 hover:bg-slate-50 border-slate-200">Re-upload file</Button>
            <Button size="sm" className="bg-[#1a2744] hover:bg-[#243b67] gap-2 px-5 ml-auto shadow-sm" onClick={() => setStep(2)} disabled={validRows.length === 0}>
              <UserPlus className="w-4 h-4 text-blue-300" />Review & Confirm ({validRows.length} user{validRows.length !== 1 ? "s" : ""})
            </Button>
          </div>

          <Dialog open={accessOverrideId !== null} onOpenChange={(o) => { if (!o) setAccessOverrideId(null) }}>
            <DialogContent className="max-w-3xl">
              {(() => {
                const activeOverrideRow = rows.find(r => r._id === accessOverrideId);
                if (!activeOverrideRow) return null;
                return (
                  <>
                    <DialogHeader><DialogTitle>Configure Access: {activeOverrideRow.full_name || activeOverrideRow.email}</DialogTitle></DialogHeader>
                    <div className="py-2">
                       <AccessPanel 
                         role={activeOverrideRow.role}
                         modulePerms={activeOverrideRow.module_permissions || getRoleDefaultModulePerms(activeOverrideRow.role)}
                         setModulePerms={(p) => setRows((prev) => prev.map((r) => r._id === accessOverrideId ? { ...r, module_permissions: typeof p === 'function' ? p(activeOverrideRow.module_permissions || getRoleDefaultModulePerms(activeOverrideRow.role)) : p } : r))}
                         pagePerms={activeOverrideRow.page_permissions || {}}
                         setPagePerms={(p) => setRows((prev) => prev.map((r) => r._id === accessOverrideId ? { ...r, page_permissions: typeof p === 'function' ? p(activeOverrideRow.page_permissions || {}) : p } : r))}
                       />
                    </div>
                    <div className="flex justify-end gap-2 mt-4">
                      <Button onClick={() => setAccessOverrideId(null)} className="bg-[#1a2744] hover:bg-[#243b67]">Done</Button>
                    </div>
                  </>
                );
              })()}
            </DialogContent>
          </Dialog>
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
                return (
                  <div key={r._id} className="grid grid-cols-[1.5fr_1.5fr_1fr] gap-2 items-center px-3 py-2.5 text-xs">
                    <span className="font-medium text-slate-800">{r.full_name || "—"}</span>
                    <span className="text-slate-500 truncate">{r.email}</span>
                    <div className="flex flex-wrap gap-1">
                      {parseRoles(r.role).length > 0 ? (
                        parseRoles(r.role).map((rl) => {
                          if (rl === "custom") return <Badge key={rl} className="text-[10px] bg-pink-100 text-pink-700">Custom Role</Badge>;
                          const rd = ROLE_DEFINITIONS.find((d) => d.value === rl);
                          return (
                            <span key={rl} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${rd?.color || "bg-slate-100 text-slate-600"}`}>
                              {rd?.label || rl}
                            </span>
                          );
                        })
                      ) : <span className="text-slate-400 italic">No roles</span>}
                      {r.module_permissions !== null && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">Overrides</span>}
                    </div>
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
