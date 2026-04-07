import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Upload, Download, CheckCircle2, Loader2, AlertCircle,
  FileText, X, Sparkles, FileSpreadsheet, FileType2
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CSV_TEMPLATES } from "@/services/parsingEngine";
import { extractFromFile, methodLabel, methodBadgeClass } from "@/services/documentExtractor";
import {
  BuildingService, UnitService, RevenueService, ExpenseService,
  PropertyService, LeaseService, TenantService, GLAccountService,
} from "@/services/api";

// ── Service router ────────────────────────────────────────────────────────────
const SERVICE_MAP = {
  building: BuildingService, unit: UnitService,
  revenue: RevenueService,   expense: ExpenseService,
  property: PropertyService, lease: LeaseService,
  tenant: TenantService,     gl_account: GLAccountService, gl: GLAccountService,
};

// ── Human-readable field labels ───────────────────────────────────────────────
const FIELD_LABELS = {
  name: 'Name', property_name: 'Property', property_id: 'Property ID',
  address: 'Address', city: 'City', state: 'State', zip: 'Zip',
  property_type: 'Property Type', total_sqft: 'Total SQFT', year_built: 'Year Built',
  status: 'Status', portfolio_id: 'Portfolio', tenant_name: 'Tenant', tenant_id: 'Tenant ID',
  start_date: 'Start Date', end_date: 'End Date', monthly_rent: 'Monthly Rent',
  annual_rent: 'Annual Rent', rent_per_sf: 'Rent/SF', square_footage: 'SF',
  lease_type: 'Lease Type', lease_term_months: 'Term (mo)', security_deposit: 'Deposit',
  cam_amount: 'CAM', escalation_rate: 'Escalation %', unit_number: 'Unit',
  building_id: 'Building', floor: 'Floor', unit_type: 'Unit Type',
  date: 'Date', amount: 'Amount', category: 'Category', vendor: 'Vendor',
  description: 'Description', classification: 'Classification', gl_code: 'GL Code',
  month: 'Month', fiscal_year: 'Fiscal Year', notes: 'Notes',
  email: 'Email', phone: 'Phone', company: 'Company', code: 'Code',
  type: 'Type', total_units: 'Units', floors: 'Floors', market_value: 'Market Value',
};

const MODULE_TITLES = {
  property: 'Properties', building: 'Buildings', unit: 'Units',
  lease: 'Leases', tenant: 'Tenants', revenue: 'Revenue',
  expense: 'Expenses', gl_account: 'GL Accounts', gl: 'GL Accounts',
  invoice: 'Invoices', vendor: 'Vendors',
};

// ── Accepted file types by extension → human label + icon component ───────────
const FILE_TYPE_INFO = [
  { ext: '.csv',  label: 'CSV',   icon: FileText,        color: 'text-emerald-600' },
  { ext: '.xlsx', label: 'Excel', icon: FileSpreadsheet, color: 'text-green-700'   },
  { ext: '.xls',  label: 'Excel', icon: FileSpreadsheet, color: 'text-green-700'   },
  { ext: '.pdf',  label: 'PDF',   icon: FileType2,       color: 'text-red-500'     },
  { ext: '.docx', label: 'Word',  icon: FileType2,       color: 'text-blue-600'    },
  { ext: '.doc',  label: 'Word',  icon: FileType2,       color: 'text-blue-600'    },
  { ext: '.txt',  label: 'Text',  icon: FileText,        color: 'text-slate-500'   },
];
const ACCEPT_ATTR = FILE_TYPE_INFO.map(f => f.ext).join(',');

// ── Template download ─────────────────────────────────────────────────────────
function downloadTemplate(moduleType) {
  const content = CSV_TEMPLATES?.[moduleType];
  if (!content) {
    toast.info(`No CSV template available for ${moduleType}. Any supported format will work.`);
    return;
  }
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${moduleType}_template.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function BulkImportModal({ isOpen, onClose, moduleType, propertyId }) {
  const queryClient = useQueryClient();
  const [file, setFile]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [importing, setImporting] = useState(false);
  const [data, setData]           = useState(null);
  const [method, setMethod]       = useState(null);
  const [errors, setErrors]       = useState([]);
  const [tab, setTab]             = useState('preview');

  const title   = MODULE_TITLES[moduleType] || moduleType;
  const service = SERVICE_MAP[moduleType];

  const reset = () => {
    setData(null); setFile(null); setMethod(null);
    setErrors([]); setTab('preview');
  };

  const handleFileUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setLoading(true);
    reset();

    try {
      const result = await extractFromFile(f, moduleType);

      if (!result.rows || result.rows.length === 0) {
        toast.warning('No records found in this file. Check the file content and format.');
        return;
      }

      // Field-level validation warnings
      const warns = [];
      result.rows.forEach(row => {
        if (moduleType === 'property' && !row.name)        warns.push(`Row ${row._row}: Missing property name.`);
        if (moduleType === 'lease'    && !row.tenant_name) warns.push(`Row ${row._row}: Missing tenant name.`);
        if (moduleType === 'expense'  && !row.amount)      warns.push(`Row ${row._row}: Missing amount.`);
        if (moduleType === 'tenant'   && !row.name)        warns.push(`Row ${row._row}: Missing name.`);
      });

      setErrors(warns);
      setData(result.rows);
      setMethod(result.method);

      if (result.warning) toast.warning(result.warning);
      toast.success(`${result.rows.length} records extracted via ${methodLabel(result.method)}.`);
    } catch (err) {
      console.error(`[BulkImportModal] ${moduleType} extract error:`, err);
      toast.error(err.message || 'Failed to process file. Check the format and try again.');
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async () => {
    if (!data?.length) return;
    if (!service) { toast.error(`No import service configured for "${moduleType}".`); return; }
    setImporting(true);

    let count = 0, skipped = 0;
    for (const row of data) {
      const { _row, ...cleanData } = row;
      if (propertyId && !cleanData.property_id) cleanData.property_id = propertyId;
      // Remove empty values
      Object.keys(cleanData).forEach(k => {
        if (cleanData[k] === undefined || cleanData[k] === null || cleanData[k] === '') delete cleanData[k];
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
      ? `Imported ${count} records. ${skipped} rows skipped due to errors.`
      : `Successfully imported ${count} ${title} records.`;
    skipped > 0 ? toast.warning(msg) : toast.success(msg);

    queryClient.invalidateQueries();
    onClose(); reset();
    setImporting(false);
  };

  const previewCols = data?.length > 0
    ? Object.keys(data[0]).filter(k => k !== '_row').slice(0, 8)
    : [];

  const isAI = method === 'ai_gemini';

  return (
    <Dialog open={isOpen} onOpenChange={v => { if (!v) { onClose(); reset(); } }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col p-0">

        {/* ── Header ─────────────────────────────────────────────── */}
        <DialogHeader className="p-6 pb-3 border-b bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg">Bulk Import — {title}</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Upload any file format — CSV, Excel, PDF, Word, or plain text.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              {CSV_TEMPLATES?.[moduleType] && (
                <Button variant="outline" size="sm" onClick={() => downloadTemplate(moduleType)} className="text-xs">
                  <FileText className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
                  CSV Template
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!data ? (
            /* ── Upload Zone ─────────────────────────────────────── */
            <div
              className="border-2 border-dashed border-slate-200 rounded-xl p-12 text-center
                bg-slate-50/50 hover:border-blue-300 hover:bg-blue-50/20 transition-colors"
            >
              <Upload className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-base font-semibold text-slate-800 mb-1">Upload a Document</h3>
              <p className="text-sm text-slate-400 mb-5">Any format is supported</p>

              {/* Supported format badges */}
              <div className="flex justify-center flex-wrap gap-2 mb-7">
                {FILE_TYPE_INFO.map(ft => {
                  const Icon = ft.icon;
                  return (
                    <span key={ft.ext}
                      className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white border border-slate-200 shadow-sm"
                    >
                      <Icon className={`w-3 h-3 ${ft.color}`} />
                      {ft.label}
                    </span>
                  );
                })}
              </div>

              {loading ? (
                <div className="flex flex-col items-center gap-3">
                  {isAI ? (
                    <Sparkles className="w-6 h-6 text-violet-500 animate-pulse" />
                  ) : (
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  )}
                  <span className="text-sm text-slate-500">
                    {file?.name?.endsWith('.pdf') || file?.name?.endsWith('.docx')
                      ? 'Extracting text & running AI analysis…'
                      : 'Processing file…'}
                  </span>
                  {(file?.name?.endsWith('.pdf') || file?.name?.endsWith('.docx')) && (
                    <span className="text-xs text-violet-500">Gemini 1.5 Pro is reading your document…</span>
                  )}
                </div>
              ) : (
                <label className="inline-block cursor-pointer">
                  <input type="file" accept={ACCEPT_ATTR} className="hidden" onChange={handleFileUpload} />
                  <Button asChild className="bg-blue-600 hover:bg-blue-700">
                    <span><Upload className="w-4 h-4 mr-2" />Browse Files</span>
                  </Button>
                </label>
              )}

              {/* AI note */}
              <p className="text-[10px] text-slate-400 mt-5 flex items-center justify-center gap-1">
                <Sparkles className="w-3 h-3 text-violet-400" />
                PDF, Word files are processed using Google Gemini 1.5 Pro
              </p>
            </div>
          ) : (
            /* ── Data Preview ─────────────────────────────────────── */
            <div className="space-y-4">
              {/* Status bar */}
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-sm font-medium text-emerald-800">
                    {data.length} records from <span className="font-bold">{file?.name}</span>
                  </span>
                  {method && (
                    <Badge className={`text-[9px] ${methodBadgeClass(method)}`}>
                      {isAI && <Sparkles className="w-2.5 h-2.5 mr-0.5" />}
                      {methodLabel(method)}
                    </Badge>
                  )}
                  {errors.length > 0 && (
                    <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-700 bg-amber-50">
                      {errors.length} warning{errors.length > 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={reset}
                  className="text-slate-500 hover:text-slate-800 h-7 px-2 text-xs shrink-0">
                  <X className="w-3.5 h-3.5 mr-1" />Change File
                </Button>
              </div>

              {/* Tabs */}
              <div className="flex border-b">
                {['preview', 'fields'].map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`px-4 py-2 text-xs font-semibold capitalize border-b-2 transition-colors ${
                      tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {t === 'preview' ? `Preview (${Math.min(data.length, 10)} rows)` : 'Extracted Fields'}
                  </button>
                ))}
              </div>

              {tab === 'preview' && (
                <>
                  {errors.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-amber-700 text-xs font-bold">
                        <AlertCircle className="w-3.5 h-3.5" />Validation Warnings
                      </div>
                      {errors.slice(0, 5).map((e, i) => (
                        <p key={i} className="text-[11px] text-amber-700 pl-5">{e}</p>
                      ))}
                      {errors.length > 5 && (
                        <p className="text-[11px] text-amber-500 pl-5">…and {errors.length - 5} more</p>
                      )}
                    </div>
                  )}

                  <div className="border rounded-lg overflow-hidden">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-slate-50">
                            <TableHead className="text-[10px] font-bold text-slate-400 w-10">#</TableHead>
                            {previewCols.map(key => (
                              <TableHead key={key} className="text-[10px] font-bold uppercase whitespace-nowrap">
                                {(FIELD_LABELS[key] || key).replace(/_/g, ' ')}
                              </TableHead>
                            ))}
                            {Object.keys(data[0]).filter(k => k !== '_row').length > 8 && (
                              <TableHead className="text-[10px] text-slate-400">…more</TableHead>
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.slice(0, 10).map((row, i) => (
                            <TableRow key={i}
                              className={errors.some(e => e.startsWith(`Row ${row._row}`)) ? 'bg-amber-50/50' : ''}>
                              <TableCell className="text-[10px] text-slate-400 py-1.5">{row._row}</TableCell>
                              {previewCols.map((key, j) => (
                                <TableCell key={j} className="text-xs py-1.5 max-w-[160px] truncate">
                                  {row[key] != null && row[key] !== ''
                                    ? String(row[key])
                                    : <span className="text-slate-300">—</span>}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {data.length > 10 && (
                      <div className="p-2 text-center border-t bg-slate-50 text-[10px] text-slate-400">
                        Showing first 10 of {data.length} rows
                      </div>
                    )}
                  </div>
                </>
              )}

              {tab === 'fields' && data.length > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] font-bold uppercase">Extracted Field</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Human Label</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Sample Value (row 1)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.keys(data[0]).filter(k => k !== '_row').map((key, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs font-mono text-blue-700">{key}</TableCell>
                          <TableCell className="text-xs text-slate-600">
                            {FIELD_LABELS[key] || <span className="text-slate-400 italic">unmapped</span>}
                          </TableCell>
                          <TableCell className="text-xs text-slate-500 max-w-[200px] truncate">
                            {data[0][key] != null && data[0][key] !== ''
                              ? String(data[0][key])
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

        {/* ── Footer ─────────────────────────────────────────────── */}
        <DialogFooter className="p-4 border-t bg-slate-50/80 flex items-center gap-2">
          <Button variant="outline" onClick={() => { onClose(); reset(); }} disabled={importing}>
            Cancel
          </Button>
          {data && (
            <>
              <p className="text-xs text-slate-400 flex-1 text-right mr-2">
                {data.length} record{data.length !== 1 ? 's' : ''} ready to import
              </p>
              <Button
                onClick={executeImport}
                disabled={importing || !service}
                className="bg-emerald-600 hover:bg-emerald-700 min-w-[160px]"
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing…</>
                  : <><Download className="w-4 h-4 mr-2" />Import {data.length} Records</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
