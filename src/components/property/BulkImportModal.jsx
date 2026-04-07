import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, Download, CheckCircle2, Loader2, AlertCircle, FileText, Info, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as parsers from "@/services/parsingEngine";
import { 
  BuildingService, 
  UnitService, 
  RevenueService, 
  ExpenseService, 
  PropertyService,
  LeaseService,
  TenantService,
  GLAccountService,
} from "@/services/api";

const SERVICE_MAP = {
  building:   BuildingService,
  unit:       UnitService,
  revenue:    RevenueService,
  expense:    ExpenseService,
  property:   PropertyService,
  lease:      LeaseService,
  tenant:     TenantService,
  gl_account: GLAccountService,
  gl:         GLAccountService,
};

const PARSER_MAP = {
  building:   parsers.parseBuildings,
  unit:       parsers.parseUnits,
  revenue:    parsers.parseRevenue,
  expense:    parsers.parseExpenses,
  property:   parsers.parseProperties,
  lease:      parsers.parseLeases,
  tenant:     parsers.parseTenants,
  gl_account: parsers.parseGLAccounts,
  gl:         parsers.parseGLAccounts,
  invoice:    parsers.parseGeneric,
  vendor:     parsers.parseGeneric,
};

// Human-readable labels for known canonical field names
const FIELD_LABELS = {
  name: 'Name',
  property_name: 'Property',
  property_id: 'Property ID',
  address: 'Address',
  city: 'City',
  state: 'State',
  zip: 'Zip Code',
  property_type: 'Property Type',
  total_sqft: 'Total SQFT',
  year_built: 'Year Built',
  status: 'Status',
  portfolio_id: 'Portfolio',
  tenant_name: 'Tenant Name',
  tenant_id: 'Tenant ID',
  start_date: 'Start Date',
  end_date: 'End Date',
  monthly_rent: 'Monthly Rent',
  annual_rent: 'Annual Rent',
  rent_per_sf: 'Rent/SF',
  square_footage: 'Square Footage',
  lease_type: 'Lease Type',
  lease_term_months: 'Lease Term (months)',
  security_deposit: 'Security Deposit',
  cam_amount: 'CAM Amount',
  nnn_amount: 'NNN Amount',
  escalation_rate: 'Escalation Rate',
  unit_number: 'Unit Number',
  unit_id: 'Unit ID',
  building_id: 'Building ID',
  floor: 'Floor',
  unit_type: 'Unit Type',
  date: 'Date',
  amount: 'Amount',
  category: 'Category',
  vendor: 'Vendor',
  description: 'Description',
  classification: 'Classification',
  gl_code: 'GL Code',
  month: 'Month',
  fiscal_year: 'Fiscal Year',
  notes: 'Notes',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  code: 'Account Code',
  type: 'Type',
  total_units: 'Total Units',
  floors: 'Floors',
};

const MODULE_TITLES = {
  property: 'Properties',
  building: 'Buildings',
  unit: 'Units',
  lease: 'Leases',
  tenant: 'Tenants',
  revenue: 'Revenue',
  expense: 'Expenses',
  gl_account: 'GL Accounts',
  gl: 'GL Accounts',
  invoice: 'Invoices',
  vendor: 'Vendors',
};

function downloadTemplate(moduleType) {
  const templates = parsers.CSV_TEMPLATES;
  const content = templates?.[moduleType];
  if (!content) {
    toast.info(`No template available for ${moduleType}. Please use your own CSV with appropriate column headers.`);
    return;
  }
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${moduleType}_template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BulkImportModal({ isOpen, onClose, moduleType, propertyId }) {
  const queryClient = useQueryClient();
  const [file, setFile]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [data, setData]       = useState(null);
  const [mapping, setMapping] = useState(null); // { originalHeader: canonicalField }
  const [errors, setErrors]   = useState([]); // per-row validation warnings
  const [tab, setTab]         = useState('preview'); // 'preview' | 'mapping'

  const title     = MODULE_TITLES[moduleType] || moduleType;
  const parser    = PARSER_MAP[moduleType];
  const service   = SERVICE_MAP[moduleType];
  const hasTemplate = !!(parsers.CSV_TEMPLATES?.[moduleType]);

  const reset = () => { setData(null); setFile(null); setMapping(null); setErrors([]); setTab('preview'); };

  const handleFileUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setLoading(true);
    reset();

    try {
      const text = await f.text();
      if (!parser) throw new Error(`No parser found for module type "${moduleType}"`);

      const result = parser(text);

      if (result.rows.length === 0) {
        toast.warning('No data rows found in this file. Check the CSV format.');
        return;
      }

      // Build mapping table: originalHeader → canonical field
      const hdrMap = {};
      if (result.headers) {
        result.headers.forEach(h => {
          // Find what the parser resolved this header to
          const firstRow = result.rows[0];
          // We detect by checking the resolved column map
          hdrMap[h] = result.columnMap
            ? (() => {
                // Rebuild resolveColumn logic to show mapping
                const norm = h.toLowerCase().replace(/[()$%#*]/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                const cm   = result.columnMap;
                if (cm[norm]) return cm[norm];
                return norm;
              })()
            : h;
        });
      }
      setMapping(hdrMap);

      // Light validation: warn on empty required fields
      const warns = [];
      result.rows.forEach(row => {
        if (moduleType === 'property' && !row.name) warns.push(`Row ${row._row}: Missing property name.`);
        if (moduleType === 'lease'    && !row.tenant_name) warns.push(`Row ${row._row}: Missing tenant name.`);
        if (moduleType === 'expense'  && !row.amount) warns.push(`Row ${row._row}: Missing amount.`);
        if (moduleType === 'tenant'   && !row.name) warns.push(`Row ${row._row}: Missing tenant name.`);
      });
      setErrors(warns);
      setData(result.rows);
      toast.success(`${result.rows.length} rows parsed${warns.length ? ` (${warns.length} warnings)` : ''}.`);
    } catch (err) {
      console.error(`[BulkImportModal] ${moduleType} parse error:`, err);
      toast.error(`Failed to parse file: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async () => {
    if (!data || data.length === 0) return;
    if (!service) {
      toast.error(`No import service configured for "${moduleType}".`);
      return;
    }
    setImporting(true);

    try {
      let count = 0, skipped = 0;
      for (const row of data) {
        const { _row, ...cleanData } = row;

        // Inject propertyId if provided
        if (propertyId && !cleanData.property_id) {
          cleanData.property_id = propertyId;
        }

        // Remove undefined values (optional fields we didn't receive)
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
        ? `Imported ${count} records. ${skipped} rows skipped due to errors.`
        : `Successfully imported ${count} ${title} records.`;
      skipped > 0 ? toast.warning(msg) : toast.success(msg);

      queryClient.invalidateQueries();
      onClose();
      reset();
    } catch (err) {
      console.error(`[BulkImportModal] ${moduleType} import error:`, err);
      toast.error(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  // Columns to show in preview (limit to avoid overflow)
  const previewCols = data && data.length > 0
    ? Object.keys(data[0]).filter(k => k !== '_row').slice(0, 8)
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) { onClose(); reset(); } }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-6 pb-3 border-b bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg">
                Bulk Import — {title}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Upload a CSV file to import multiple {title.toLowerCase()} records at once.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              {hasTemplate && (
                <Button variant="outline" size="sm" onClick={() => downloadTemplate(moduleType)} className="text-xs">
                  <FileText className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
                  Download Template
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!data ? (
            // ── Upload Zone ─────────────────────────────────────────────
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-12 text-center bg-slate-50/50 hover:border-blue-300 hover:bg-blue-50/20 transition-colors">
              <Upload className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-base font-semibold text-slate-800 mb-1">Select CSV File</h3>
              <p className="text-sm text-slate-400 mb-2">
                The first row must contain column headers.
              </p>
              {hasTemplate && (
                <p className="text-xs text-blue-500 mb-6 cursor-pointer hover:underline" onClick={() => downloadTemplate(moduleType)}>
                  Download sample template →
                </p>
              )}
              {!hasTemplate && <div className="mb-6" />}

              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  <span className="text-sm text-slate-500">Processing file...</span>
                </div>
              ) : (
                <label className="inline-block cursor-pointer">
                  <input type="file" accept=".csv,.txt" className="hidden" onChange={handleFileUpload} />
                  <Button asChild className="bg-blue-600 hover:bg-blue-700">
                    <span><Upload className="w-4 h-4 mr-2" />Browse CSV File</span>
                  </Button>
                </label>
              )}
            </div>
          ) : (
            // ── Data Preview ────────────────────────────────────────────
            <div className="space-y-4">
              {/* Status bar */}
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm font-medium text-emerald-800">
                    {data.length} records parsed from <span className="font-bold">{file?.name}</span>
                  </span>
                  {errors.length > 0 && (
                    <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-700 bg-amber-50">
                      {errors.length} warning{errors.length > 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={reset} className="text-slate-500 hover:text-slate-800 h-7 px-2 text-xs">
                  <X className="w-3.5 h-3.5 mr-1" />Change File
                </Button>
              </div>

              {/* Tabs */}
              <div className="flex border-b">
                {['preview', 'mapping'].map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-xs font-semibold capitalize border-b-2 transition-colors ${
                      tab === t
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {t === 'preview' ? `Data Preview (${Math.min(data.length, 10)} rows)` : 'Column Mapping'}
                  </button>
                ))}
              </div>

              {tab === 'preview' && (
                <>
                  {/* Warnings */}
                  {errors.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-amber-700 text-xs font-bold">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Validation Warnings
                      </div>
                      {errors.slice(0, 5).map((e, i) => (
                        <p key={i} className="text-[11px] text-amber-700 pl-5">{e}</p>
                      ))}
                      {errors.length > 5 && (
                        <p className="text-[11px] text-amber-500 pl-5">…and {errors.length - 5} more</p>
                      )}
                    </div>
                  )}

                  {/* Table preview */}
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
                            <TableRow key={i} className={errors.some(e => e.startsWith(`Row ${row._row}`)) ? 'bg-amber-50/50' : ''}>
                              <TableCell className="text-[10px] text-slate-400 py-1.5">{row._row}</TableCell>
                              {previewCols.map((key, j) => (
                                <TableCell key={j} className="text-xs py-1.5 max-w-[140px] truncate">
                                  {row[key] != null && row[key] !== '' ? String(row[key]) : <span className="text-slate-300">—</span>}
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

              {tab === 'mapping' && mapping && (
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] font-bold uppercase">Your CSV Column</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Maps To</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Field Label</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(mapping).map(([orig, canonical], i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs font-mono text-slate-700">{orig}</TableCell>
                          <TableCell className="text-xs font-mono text-blue-700">{canonical}</TableCell>
                          <TableCell className="text-xs text-slate-500">
                            {FIELD_LABELS[canonical] || <span className="text-slate-300 italic">unknown field</span>}
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

        <DialogFooter className="p-4 border-t bg-slate-50/80 flex items-center gap-2">
          <Button variant="outline" onClick={() => { onClose(); reset(); }} disabled={importing}>
            Cancel
          </Button>
          {data && (
            <>
              <p className="text-xs text-slate-400 flex-1 text-right mr-2">
                {data.length} records will be created
              </p>
              <Button
                onClick={executeImport}
                disabled={importing || !service}
                className="bg-emerald-600 hover:bg-emerald-700 min-w-[160px]"
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing...</>
                  : <><Download className="w-4 h-4 mr-2" />Import {data.length} Records</>
                }
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
