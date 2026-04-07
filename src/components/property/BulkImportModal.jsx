import React, { useState, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Upload, Download, CheckCircle2, Loader2, AlertCircle,
  FileText, X, Sparkles, FileSpreadsheet, FileType2, Pencil,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CSV_TEMPLATES } from "@/services/parsingEngine";
import { extractFromFile, methodLabel, methodBadgeClass } from "@/services/documentExtractor";
import useOrgId from "@/hooks/useOrgId";
import {
  BuildingService, UnitService, RevenueService, ExpenseService,
  PropertyService, LeaseService, TenantService, GLAccountService,
} from "@/services/api";

// ── Service map ─────────────────────────────────────────────────────────────
const SERVICE_MAP = {
  building:   BuildingService,  unit:       UnitService,
  revenue:    RevenueService,   expense:    ExpenseService,
  property:   PropertyService,  lease:      LeaseService,
  tenant:     TenantService,    gl_account: GLAccountService,
  gl:         GLAccountService,
};

// ── Human-readable labels for every known field ─────────────────────────────
const FIELD_LABELS = {
  name: 'Name', property_name: 'Property', address: 'Address',
  city: 'City', state: 'State', zip: 'Zip', property_type: 'Type',
  total_sqft: 'Total SQFT', year_built: 'Year Built', total_units: 'Units',
  floors: 'Floors', status: 'Status', purchase_price: 'Purchase Price',
  market_value: 'Market Value', noi: 'NOI', cap_rate: 'Cap Rate %',
  manager: 'Manager', owner: 'Owner', notes: 'Notes',
  tenant_name: 'Tenant', unit_number: 'Unit', start_date: 'Start Date',
  end_date: 'End Date', lease_term_months: 'Term (mo)', monthly_rent: 'Monthly Rent',
  annual_rent: 'Annual Rent', rent_per_sf: 'Rent/SF', square_footage: 'SF',
  lease_type: 'Lease Type', security_deposit: 'Deposit', cam_amount: 'CAM',
  escalation_rate: 'Escalation %', renewal_options: 'Renewal', ti_allowance: 'TI',
  free_rent_months: 'Free Rent (mo)', effective_rent: 'Effective Rent',
  email: 'Email', phone: 'Phone', company: 'Company',
  industry: 'Industry', contact_name: 'Contact', credit_rating: 'Credit Rating',
  date: 'Date', amount: 'Amount', category: 'Category', vendor: 'Vendor',
  description: 'Description', classification: 'Classification', gl_code: 'GL Code',
  month: 'Month', fiscal_year: 'Fiscal Year', invoice_number: 'Invoice #',
  type: 'Revenue Type', code: 'Account Code', normal_balance: 'Normal Balance',
  is_active: 'Active', is_recoverable: 'Recoverable', floor: 'Floor',
  unit_type: 'Unit Type', building_id: 'Building', property_id: 'Property ID',
};

const MODULE_TITLES = {
  property: 'Properties', building: 'Buildings', unit: 'Units',
  lease: 'Leases', tenant: 'Tenants', revenue: 'Revenue Entries',
  expense: 'Expenses', gl_account: 'GL Accounts', gl: 'GL Accounts',
};

// Fields that MUST NOT be blank before import (per module)
const REQUIRED_FIELDS = {
  property:   ['name'],
  building:   ['name'],
  unit:       ['unit_number'],
  lease:      ['tenant_name', 'start_date', 'end_date'],
  tenant:     ['name'],
  revenue:    ['amount'],
  expense:    ['amount', 'date'],
  gl_account: ['code', 'name'],
  gl:         ['code', 'name'],
};

// Fields to hide from the edit grid (internal/system)
const HIDDEN_FIELDS = new Set(['_row', 'org_id', 'id', 'created_at', 'updated_at', 'total_cam']);

// Accepted file extensions
const ACCEPT_ATTR = '.csv,.xlsx,.xls,.pdf,.docx,.doc,.txt';

// ── Template download ────────────────────────────────────────────────────────
function downloadTemplate(moduleType) {
  const content = CSV_TEMPLATES?.[moduleType];
  if (!content) { toast.info('No CSV template for this module.'); return; }
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${moduleType}_template.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Row validation ───────────────────────────────────────────────────────────
function validateRows(rows, moduleType) {
  const required = REQUIRED_FIELDS[moduleType] ?? [];
  const errors = [];
  rows.forEach(row => {
    required.forEach(field => {
      if (!row[field] && row[field] !== 0) {
        errors.push(`Row ${row._row}: "${FIELD_LABELS[field] ?? field}" is required.`);
      }
    });
  });
  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function BulkImportModal({ isOpen, onClose, moduleType, propertyId }) {
  const queryClient     = useQueryClient();
  const { orgId }       = useOrgId();  // ← live org_id from AuthContext
  const [file, setFile]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [importing, setImporting] = useState(false);
  const [rows, setRows]           = useState(null);   // editable rows
  const [method, setMethod]       = useState(null);
  const [tab, setTab]             = useState('edit'); // 'edit' | 'fields'

  const title   = MODULE_TITLES[moduleType] || moduleType;
  const service = SERVICE_MAP[moduleType];

  const reset = () => {
    setRows(null); setFile(null); setMethod(null); setTab('edit');
  };

  // ── File upload handler ────────────────────────────────────────────────────
  const handleFileUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // Reset the input so the same file can be re-selected
    e.target.value = '';
    setFile(f);
    setLoading(true);
    reset();

    try {
      const result = await extractFromFile(f, moduleType);
      if (!result.rows || result.rows.length === 0) {
        toast.warning('No records found in this file. Check the content and try again.');
        return;
      }
      setRows(result.rows);
      setMethod(result.method);
      if (result.warning) toast.warning(result.warning);
      toast.success(`${result.rows.length} records extracted — review & edit below.`);
    } catch (err) {
      console.error('[BulkImportModal] extract error:', err);
      toast.error(err.message || 'Failed to process file.');
    } finally {
      setLoading(false);
    }
  };

  // ── Inline cell edit ──────────────────────────────────────────────────────
  const handleCellChange = useCallback((rowIndex, field, value) => {
    setRows(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], [field]: value };
      return next;
    });
  }, []);

  // Add a blank row
  const addRow = () => {
    setRows(prev => [...(prev || []), { _row: (prev?.length ?? 0) + 1 }]);
  };

  // Remove a row
  const removeRow = (rowIndex) => {
    setRows(prev => prev.filter((_, i) => i !== rowIndex)
      .map((r, i) => ({ ...r, _row: i + 1 })));
  };

  // ── Import execution ──────────────────────────────────────────────────────
  const executeImport = async () => {
    if (!rows?.length) return;
    if (!service) { toast.error(`No import service configured for "${moduleType}".`); return; }

    const validationErrors = validateRows(rows, moduleType);
    if (validationErrors.length > 0) {
      toast.error(`Fix validation errors before importing:\n${validationErrors.slice(0, 3).join('\n')}`);
      return;
    }

    setImporting(true);
    let count = 0, skipped = 0;

    for (const row of rows) {
      const { _row, ...cleanData } = row;

      // ── Inject required context fields ────────────────────────────────────
      // Always explicitly set org_id — do NOT rely on the api.js cache
      if (orgId && orgId !== '__none__') {
        cleanData.org_id = orgId;
      }
      if (propertyId && !cleanData.property_id) {
        cleanData.property_id = propertyId;
      }

      // Remove internal/empty fields
      Object.keys(cleanData).forEach(k => {
        if (cleanData[k] === undefined || cleanData[k] === null || cleanData[k] === '') {
          delete cleanData[k];
        }
      });

      try {
        await service.create(cleanData);
        count++;
      } catch (rowErr) {
        console.warn(`[BulkImportModal] Row ${_row} failed:`, rowErr.message);
        skipped++;
      }
    }

    const msg = skipped > 0
      ? `Imported ${count} records. ${skipped} rows skipped (errors).`
      : `Successfully imported ${count} ${title}.`;
    skipped > 0 ? toast.warning(msg) : toast.success(msg);

    queryClient.invalidateQueries();
    onClose(); reset();
    setImporting(false);
  };

  // ── Derive column keys from extracted rows ────────────────────────────────
  const colKeys = rows?.length > 0
    ? Object.keys(rows[0]).filter(k => !HIDDEN_FIELDS.has(k))
    : [];

  const validationErrors = rows ? validateRows(rows, moduleType) : [];
  const requiredFields   = REQUIRED_FIELDS[moduleType] ?? [];

  const isAI = method === 'ai_gemini';

  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <Dialog open={isOpen} onOpenChange={v => { if (!v) { onClose(); reset(); } }}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-hidden flex flex-col p-0">

        {/* ── Header ──────────────────────────────────────────────── */}
        <DialogHeader className="p-5 pb-3 border-b bg-gradient-to-r from-slate-50 to-white shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-base font-semibold">Bulk Import — {title}</DialogTitle>
              <DialogDescription className="text-xs mt-0.5 text-slate-500">
                Upload any format: CSV, Excel, PDF, Word, or text. Review and edit extracted data before importing.
              </DialogDescription>
            </div>
            {CSV_TEMPLATES?.[moduleType] && (
              <Button variant="outline" size="sm" onClick={() => downloadTemplate(moduleType)} className="text-xs">
                <FileText className="w-3.5 h-3.5 mr-1.5 text-blue-500" /> CSV Template
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">

          {/* ── Upload zone (no data yet) ────────────────────────── */}
          {!rows && !loading && (
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center bg-slate-50/50 hover:border-blue-300 hover:bg-blue-50/20 transition-colors">
              <Upload className="w-11 h-11 text-slate-300 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-slate-800 mb-1">Upload Your Document</h3>
              <p className="text-xs text-slate-400 mb-5">
                CSV, Excel (.xlsx), PDF, Word (.docx), or plain text
              </p>
              <div className="flex justify-center flex-wrap gap-2 mb-6">
                {[
                  { label: 'CSV',   color: 'text-emerald-600', Icon: FileText },
                  { label: 'Excel', color: 'text-green-700',   Icon: FileSpreadsheet },
                  { label: 'PDF',   color: 'text-red-500',     Icon: FileType2 },
                  { label: 'Word',  color: 'text-blue-600',    Icon: FileType2 },
                  { label: 'TXT',   color: 'text-slate-500',   Icon: FileText },
                ].map(({ label, color, Icon }) => (
                  <span key={label} className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white border border-slate-200 shadow-sm">
                    <Icon className={`w-3 h-3 ${color}`} /> {label}
                  </span>
                ))}
              </div>
              <label className="inline-block cursor-pointer">
                <input type="file" accept={ACCEPT_ATTR} className="hidden" onChange={handleFileUpload} />
                <Button asChild className="bg-blue-600 hover:bg-blue-700 h-9">
                  <span><Upload className="w-4 h-4 mr-2" />Browse Files</span>
                </Button>
              </label>
              <p className="text-[10px] text-slate-400 mt-4 flex items-center justify-center gap-1">
                <Sparkles className="w-3 h-3 text-violet-400" />
                PDF & Word files are processed by Google Gemini 1.5 Pro
              </p>
            </div>
          )}

          {/* ── Loading spinner ──────────────────────────────────── */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              {isAI || file?.name?.match(/\.(pdf|docx|doc)$/i)
                ? <Sparkles className="w-8 h-8 text-violet-500 animate-pulse" />
                : <Loader2 className="w-8 h-8 animate-spin text-blue-600" />}
              <p className="text-sm text-slate-600 font-medium">
                {file?.name?.match(/\.(pdf|docx|doc)$/i)
                  ? 'Gemini 1.5 Pro is reading your document…'
                  : 'Parsing file…'}
              </p>
              <p className="text-xs text-slate-400">{file?.name}</p>
            </div>
          )}

          {/* ── Data edit grid ───────────────────────────────────── */}
          {rows && !loading && (
            <div className="space-y-3">
              {/* Status bar */}
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-sm font-semibold text-emerald-800">
                    {rows.length} records from <span className="italic">{file?.name}</span>
                  </span>
                  {method && (
                    <Badge className={`text-[9px] font-semibold px-1.5 ${methodBadgeClass(method)}`}>
                      {isAI && <Sparkles className="w-2.5 h-2.5 mr-0.5" />}
                      {methodLabel(method)}
                    </Badge>
                  )}
                  {validationErrors.length > 0 && (
                    <Badge className="text-[9px] bg-red-100 text-red-700 font-semibold px-1.5">
                      <AlertCircle className="w-2.5 h-2.5 mr-0.5" />
                      {validationErrors.length} field{validationErrors.length > 1 ? 's' : ''} required
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="cursor-pointer">
                    <input type="file" accept={ACCEPT_ATTR} className="hidden" onChange={handleFileUpload} />
                    <Button variant="ghost" size="sm" asChild className="text-slate-500 hover:text-slate-800 h-7 px-2 text-xs">
                      <span><X className="w-3.5 h-3.5 mr-1" />Change</span>
                    </Button>
                  </label>
                </div>
              </div>

              {/* Validation errors summary */}
              {validationErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-red-700 mb-1">Required fields missing — fill them in the table below</p>
                    {validationErrors.slice(0, 4).map((e, i) => (
                      <p key={i} className="text-[11px] text-red-600">{e}</p>
                    ))}
                    {validationErrors.length > 4 && (
                      <p className="text-[11px] text-red-400">…and {validationErrors.length - 4} more</p>
                    )}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="flex border-b gap-1">
                {[
                  { key: 'edit',   label: `Edit Data (${rows.length} rows)` },
                  { key: 'fields', label: 'Field Map' },
                ].map(t => (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    className={`px-4 py-1.5 text-xs font-semibold border-b-2 transition-colors ${
                      tab === t.key
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500 hover:text-slate-700'
                    }`}>
                    {t.label}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2 pb-1">
                  <span className="text-[10px] text-slate-400">
                    <Pencil className="w-2.5 h-2.5 inline mr-0.5" />Click any cell to edit
                  </span>
                </div>
              </div>

              {/* ── Edit table ─────────────────────────────────── */}
              {tab === 'edit' && (
                <div className="border rounded-lg overflow-hidden">
                  <div className="overflow-auto max-h-[52vh]">
                    <Table className="text-xs min-w-max">
                      <TableHeader className="sticky top-0 z-10">
                        <TableRow className="bg-slate-100">
                          <TableHead className="text-[10px] font-bold text-slate-400 w-8 sticky left-0 bg-slate-100">#</TableHead>
                          {colKeys.map(key => {
                            const isRequired = requiredFields.includes(key);
                            return (
                              <TableHead key={key}
                                className="text-[10px] font-bold uppercase whitespace-nowrap min-w-[110px]">
                                {FIELD_LABELS[key] ?? key.replace(/_/g, ' ')}
                                {isRequired && <span className="text-red-500 ml-0.5">*</span>}
                              </TableHead>
                            );
                          })}
                          <TableHead className="text-[10px] font-bold text-slate-400 w-10">Del</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row, rIdx) => {
                          const rowHasError = validationErrors.some(e => e.startsWith(`Row ${row._row}:`));
                          return (
                            <TableRow key={rIdx}
                              className={rowHasError ? 'bg-red-50/60' : rIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}>
                              <TableCell className="text-[10px] text-slate-400 py-1 sticky left-0 bg-inherit font-mono">
                                {row._row}
                              </TableCell>
                              {colKeys.map(key => {
                                const isRequired = requiredFields.includes(key);
                                const isEmpty    = !row[key] && row[key] !== 0;
                                const isError    = isRequired && isEmpty;
                                return (
                                  <TableCell key={key} className="p-0.5">
                                    <input
                                      type="text"
                                      value={row[key] ?? ''}
                                      placeholder={isRequired ? `Required…` : '—'}
                                      onChange={e => handleCellChange(rIdx, key, e.target.value)}
                                      className={`w-full text-xs px-2 py-1 rounded border transition-colors
                                        focus:outline-none focus:ring-1 focus:ring-blue-400
                                        ${isError
                                          ? 'border-red-400 bg-red-50 placeholder-red-300'
                                          : isEmpty
                                            ? 'border-slate-200 bg-white placeholder-slate-300'
                                            : 'border-transparent bg-transparent hover:border-slate-300'
                                        }`}
                                    />
                                  </TableCell>
                                );
                              })}
                              <TableCell className="p-0.5 text-center">
                                <button onClick={() => removeRow(rIdx)}
                                  className="text-slate-300 hover:text-red-500 transition-colors text-sm leading-none">
                                  ×
                                </button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {/* Add row button */}
                  <div className="border-t p-2 bg-slate-50 flex items-center gap-2">
                    <button onClick={addRow}
                      className="text-xs text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1">
                      + Add Row Manually
                    </button>
                    <span className="text-[10px] text-slate-400 ml-auto">
                      {rows.length} record{rows.length !== 1 ? 's' : ''} total
                    </span>
                  </div>
                </div>
              )}

              {/* ── Field map ──────────────────────────────────── */}
              {tab === 'fields' && rows.length > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] font-bold uppercase">Field Key</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Label</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Required</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Row 1 Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {colKeys.map((key, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-blue-700 py-1.5">{key}</TableCell>
                          <TableCell className="text-slate-600 py-1.5">
                            {FIELD_LABELS[key] ?? <span className="text-slate-400 italic">unmapped</span>}
                          </TableCell>
                          <TableCell className="py-1.5">
                            {requiredFields.includes(key)
                              ? <span className="text-red-600 font-bold">Yes</span>
                              : <span className="text-slate-400">—</span>}
                          </TableCell>
                          <TableCell className="text-slate-500 py-1.5 max-w-[200px] truncate">
                            {rows[0][key] != null && rows[0][key] !== ''
                              ? String(rows[0][key])
                              : <span className="text-slate-300">null</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <DialogFooter className="p-4 border-t bg-slate-50/80 flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={() => { onClose(); reset(); }} disabled={importing}>
            Cancel
          </Button>
          {rows && (
            <>
              {validationErrors.length > 0 && (
                <span className="text-[11px] text-red-600 flex-1 text-right mr-2">
                  <AlertCircle className="w-3 h-3 inline mr-0.5" />
                  Fill required fields marked with * before importing
                </span>
              )}
              <Button
                onClick={executeImport}
                disabled={importing || !service || validationErrors.length > 0}
                className={`min-w-[160px] ${validationErrors.length > 0
                  ? 'bg-slate-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700'}`}
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing…</>
                  : <><Download className="w-4 h-4 mr-2" />Import {rows.length} Records</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
