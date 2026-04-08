import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Upload, CheckCircle2, Loader2, AlertCircle,
  FileText, Sparkles, FileSpreadsheet, FileType2, X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CSV_TEMPLATES } from "@/services/parsingEngine";
import { extractFromFile, methodLabel, methodBadgeClass } from "@/services/documentExtractor";
import { supabase } from "@/services/supabaseClient";
import {
  BuildingService, UnitService, RevenueService, ExpenseService,
  PropertyService, LeaseService, TenantService, GLAccountService,
} from "@/services/api";

// ── Service map ──────────────────────────────────────────────────────────────
const SERVICE_MAP = {
  building: BuildingService, unit: UnitService,
  revenue: RevenueService,   expense: ExpenseService,
  property: PropertyService, lease: LeaseService,
  tenant: TenantService,     gl_account: GLAccountService, gl: GLAccountService,
};

const MODULE_TITLES = {
  property: 'Properties', building: 'Buildings', unit: 'Units',
  lease: 'Leases', tenant: 'Tenants', revenue: 'Revenue Entries',
  expense: 'Expenses', gl_account: 'GL Accounts', gl: 'GL Accounts',
};

// ── All fields per module — shown in the edit grid ──────────────────────────
// { key, label, required, placeholder }
const MODULE_FIELDS = {
  property: [
    { key: 'name',           label: 'Property Name',  required: true,  placeholder: 'e.g. Sunset Plaza' },
    { key: 'address',        label: 'Address',         required: false, placeholder: '123 Main St' },
    { key: 'city',           label: 'City',            required: false, placeholder: 'Phoenix' },
    { key: 'state',          label: 'State',           required: false, placeholder: 'AZ' },
    { key: 'zip',            label: 'ZIP',             required: false, placeholder: '85001' },
    { key: 'property_type',  label: 'Type',            required: false, placeholder: 'office / retail / industrial…' },
    { key: 'total_sf',       label: 'Total SF',        required: false, placeholder: '50000' },
    { key: 'total_units',    label: 'Units',           required: false, placeholder: '10' },
    { key: 'floors',         label: 'Floors',          required: false, placeholder: '5' },
    { key: 'year_built',     label: 'Year Built',      required: false, placeholder: '1998' },
    { key: 'status',         label: 'Status',          required: false, placeholder: 'active' },
    { key: 'purchase_price', label: 'Purchase Price',  required: false, placeholder: '5000000' },
    { key: 'market_value',   label: 'Market Value',    required: false, placeholder: '6000000' },
    { key: 'noi',            label: 'NOI (Annual)',     required: false, placeholder: '350000' },
    { key: 'cap_rate',       label: 'Cap Rate %',      required: false, placeholder: '5.5' },
    { key: 'manager',        label: 'Property Manager',required: false, placeholder: 'Manager name' },
    { key: 'notes',          label: 'Notes',           required: false, placeholder: 'Additional info…' },
  ],
  building: [
    { key: 'name',       label: 'Building Name', required: true,  placeholder: 'Building A' },
    { key: 'address',    label: 'Address',       required: false, placeholder: '123 Main St' },
    { key: 'total_sf',   label: 'Total SF',      required: false, placeholder: '50000' },
    { key: 'floors',     label: 'Floors',        required: false, placeholder: '5' },
    { key: 'year_built', label: 'Year Built',    required: false, placeholder: '1998' },
    { key: 'status',     label: 'Status',        required: false, placeholder: 'active' },
  ],
  unit: [
    { key: 'unit_number',    label: 'Unit #',        required: true,  placeholder: '101' },
    { key: 'floor',          label: 'Floor',         required: false, placeholder: '1' },
    { key: 'square_footage', label: 'Square Feet',   required: false, placeholder: '1200' },
    { key: 'unit_type',      label: 'Unit Type',     required: false, placeholder: 'office' },
    { key: 'status',         label: 'Status',        required: false, placeholder: 'vacant / occupied' },
    { key: 'monthly_rent',   label: 'Monthly Rent',  required: false, placeholder: '2500' },
    { key: 'tenant_name',    label: 'Tenant Name',   required: false, placeholder: 'Acme Corp' },
  ],
  lease: [
    { key: 'tenant_name',      label: 'Tenant Name',    required: true,  placeholder: 'Acme Corp' },
    { key: 'property_name',    label: 'Property',       required: false, placeholder: 'Sunset Plaza' },
    { key: 'unit_number',      label: 'Unit / Suite',   required: false, placeholder: '101' },
    { key: 'start_date',       label: 'Start Date',     required: true,  placeholder: 'YYYY-MM-DD' },
    { key: 'end_date',         label: 'End Date',       required: true,  placeholder: 'YYYY-MM-DD' },
    { key: 'lease_term_months',label: 'Term (months)',  required: false, placeholder: '60' },
    { key: 'monthly_rent',     label: 'Monthly Rent',   required: false, placeholder: '5000' },
    { key: 'annual_rent',      label: 'Annual Rent',    required: false, placeholder: '60000' },
    { key: 'rent_per_sf',      label: 'Rent/SF (ann.)', required: false, placeholder: '25.00' },
    { key: 'square_footage',   label: 'Square Feet',    required: false, placeholder: '2400' },
    { key: 'lease_type',       label: 'Lease Type',     required: false, placeholder: 'nnn / gross / modified_gross' },
    { key: 'security_deposit', label: 'Security Dep.',  required: false, placeholder: '10000' },
    { key: 'cam_amount',       label: 'CAM (Annual)',   required: false, placeholder: '5000' },
    { key: 'escalation_rate',  label: 'Escalation %',  required: false, placeholder: '3' },
    { key: 'renewal_options',  label: 'Renewal Options',required: false, placeholder: '2×5yr options' },
    { key: 'ti_allowance',     label: 'TI Allowance',  required: false, placeholder: '25000' },
    { key: 'status',           label: 'Status',         required: false, placeholder: 'active' },
    { key: 'notes',            label: 'Notes',          required: false, placeholder: '' },
  ],
  tenant: [
    { key: 'name',         label: 'Tenant Name',  required: true,  placeholder: 'Acme Corp' },
    { key: 'company',      label: 'Company',      required: false, placeholder: 'Acme Inc.' },
    { key: 'contact_name', label: 'Contact',      required: false, placeholder: 'John Smith' },
    { key: 'email',        label: 'Email',        required: false, placeholder: 'john@acme.com' },
    { key: 'phone',        label: 'Phone',        required: false, placeholder: '555-0100' },
    { key: 'industry',     label: 'Industry',     required: false, placeholder: 'Technology' },
    { key: 'credit_rating',label: 'Credit Rating',required: false, placeholder: 'A+' },
    { key: 'status',       label: 'Status',       required: false, placeholder: 'active' },
    { key: 'notes',        label: 'Notes',        required: false, placeholder: '' },
  ],
  expense: [
    { key: 'date',          label: 'Date',           required: true,  placeholder: 'YYYY-MM-DD' },
    { key: 'amount',        label: 'Amount ($)',      required: true,  placeholder: '1250.00' },
    { key: 'category',      label: 'Category',       required: false, placeholder: 'maintenance' },
    { key: 'vendor',        label: 'Vendor',         required: false, placeholder: 'ABC Services' },
    { key: 'description',   label: 'Description',    required: false, placeholder: '' },
    { key: 'classification',label: 'Classification', required: false, placeholder: 'recoverable / non_recoverable' },
    { key: 'gl_code',       label: 'GL Code',        required: false, placeholder: '5100' },
    { key: 'property_name', label: 'Property',       required: false, placeholder: '' },
    { key: 'invoice_number',label: 'Invoice #',      required: false, placeholder: '' },
    { key: 'fiscal_year',   label: 'Fiscal Year',    required: false, placeholder: '2024' },
    { key: 'month',         label: 'Month (1–12)',   required: false, placeholder: '3' },
  ],
  revenue: [
    { key: 'amount',        label: 'Amount ($)',    required: true,  placeholder: '5000.00' },
    { key: 'date',          label: 'Date',          required: false, placeholder: 'YYYY-MM-DD' },
    { key: 'type',          label: 'Revenue Type',  required: false, placeholder: 'base_rent / cam_recovery…' },
    { key: 'property_name', label: 'Property',      required: false, placeholder: '' },
    { key: 'tenant_name',   label: 'Tenant',        required: false, placeholder: '' },
    { key: 'fiscal_year',   label: 'Fiscal Year',   required: false, placeholder: '2024' },
    { key: 'month',         label: 'Month (1–12)',  required: false, placeholder: '3' },
    { key: 'notes',         label: 'Notes',         required: false, placeholder: '' },
  ],
  gl_account: [
    { key: 'code',          label: 'Account Code',    required: true,  placeholder: '5100' },
    { key: 'name',          label: 'Account Name',    required: true,  placeholder: 'Maintenance Expense' },
    { key: 'type',          label: 'Type',            required: false, placeholder: 'income / expense / asset…' },
    { key: 'category',      label: 'Category',        required: false, placeholder: '' },
    { key: 'normal_balance',label: 'Normal Balance',  required: false, placeholder: 'debit / credit' },
    { key: 'is_active',     label: 'Active?',         required: false, placeholder: 'true / false' },
    { key: 'is_recoverable',label: 'Recoverable?',    required: false, placeholder: 'true / false' },
    { key: 'notes',         label: 'Notes',           required: false, placeholder: '' },
  ],
};
MODULE_FIELDS.gl = MODULE_FIELDS.gl_account;

const ACCEPT_ATTR = '.csv,.xlsx,.xls,.pdf,.docx,.doc,.txt';

// ── Template download ─────────────────────────────────────────────────────────
function downloadTemplate(moduleType) {
  const content = CSV_TEMPLATES?.[moduleType];
  if (!content) { toast.info('No CSV template for this module.'); return; }
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${moduleType}_template.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Resolve org_id directly from Supabase (most reliable) ────────────────────
async function resolveOrgId() {
  try {
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) return null;

    // Check app_metadata first (set by backend on invite/approval)
    if (authUser.app_metadata?.org_id) return authUser.app_metadata.org_id;

    // Query memberships table directly
    const { data: mem } = await supabase
      .from('memberships')
      .select('org_id')
      .eq('user_id', authUser.id)
      .limit(1)
      .maybeSingle();

    if (mem?.org_id) return mem.org_id;

    // Fallback: Pick the first available organization (crucial for SuperAdmins who don't have a specific membership)
    const { data: org } = await supabase.from('organizations').select('id').limit(1).maybeSingle();
    return org?.id || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EditableCell — uses defaultValue + onBlur to avoid focus-loss on keystroke
// ─────────────────────────────────────────────────────────────────────────────
const EditableCell = React.memo(({ value, placeholder, isRequired, isEmpty, onChange }) => {
  const inputRef = useRef(null);

  // Sync external value changes (e.g. new file loaded)
  useEffect(() => {
    if (inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.value = value ?? '';
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={value ?? ''}
      placeholder={isRequired && isEmpty ? 'Required…' : (placeholder || '—')}
      onBlur={e => onChange(e.target.value)}
      className={[
        'w-full text-xs px-2 py-1.5 rounded border transition-colors outline-none',
        'focus:ring-1 focus:ring-blue-400 focus:border-blue-400',
        isRequired && isEmpty
          ? 'border-red-400 bg-red-50 placeholder-red-400 text-red-800'
          : 'border-transparent bg-transparent hover:border-slate-300 hover:bg-white focus:bg-white',
      ].join(' ')}
    />
  );
});
EditableCell.displayName = 'EditableCell';

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function BulkImportModal({ isOpen, onClose, moduleType, propertyId, buildingId }) {
  const queryClient = useQueryClient();
  const [file, setFile]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // rows: array of plain objects keyed by field key
  const [rows, setRows]       = useState(null);
  const [method, setMethod]   = useState(null);

  const title   = MODULE_TITLES[moduleType] || moduleType;
  const service = SERVICE_MAP[moduleType];
  const fieldDefs = MODULE_FIELDS[moduleType] ?? [];
  const requiredFields = fieldDefs.filter(f => f.required).map(f => f.key);

  const reset = () => { setRows(null); setFile(null); setMethod(null); };

  // ── Merge extracted rows with full field template ─────────────────────────
  const buildRows = useCallback((extractedRows) => {
    const defaultRow = Object.fromEntries(fieldDefs.map(f => [f.key, null]));
    const allowedKeys = new Set(fieldDefs.map(f => f.key));
    
    return extractedRows.map((extracted, idx) => {
      // STRICT FILTER: Only keep fields explicitly defined in MODULE_FIELDS for this specific module
      const filteredExtracted = Object.fromEntries(
        Object.entries(extracted).filter(([k]) => allowedKeys.has(k))
      );
      
      return {
        ...defaultRow,
        ...filteredExtracted,
        _row: idx + 1,
      };
    });
  }, [fieldDefs]);

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFileUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    setFile(f);
    setLoading(true);
    reset();

    try {
      const result = await extractFromFile(f, moduleType);
      if (!result.rows?.length) {
        toast.warning('No records found. Try a different file or format.');
        return;
      }
      setRows(buildRows(result.rows));
      setMethod(result.method);
      toast.success(`${result.rows.length} record${result.rows.length !== 1 ? 's' : ''} extracted — review and edit below.`);
    } catch (err) {
      toast.error(err.message || 'Failed to process file.');
    } finally {
      setLoading(false);
    }
  };

  // ── Cell change (called on blur) ──────────────────────────────────────────
  const handleCellChange = useCallback((rowIndex, fieldKey, value) => {
    setRows(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], [fieldKey]: value === '' ? null : value };
      return next;
    });
  }, []);

  const addRow = () => {
    const defaultRow = Object.fromEntries(fieldDefs.map(f => [f.key, null]));
    setRows(prev => [...(prev ?? []), { ...defaultRow, _row: (prev?.length ?? 0) + 1 }]);
  };

  const removeRow = (idx) => {
    setRows(prev => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, _row: i + 1 })));
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const getRowErrors = (row) => {
    return requiredFields.filter(f => !row[f] && row[f] !== 0);
  };

  const allErrors = rows ? rows.flatMap((row, i) =>
    getRowErrors(row).map(f => `Row ${i + 1}: "${fieldDefs.find(d => d.key === f)?.label ?? f}" is required`)
  ) : [];

  const canImport = rows && rows.length > 0 && allErrors.length === 0 && !importing;

  // ── Import execution ──────────────────────────────────────────────────────
  const executeImport = async () => {
    if (!canImport) return;

    setImporting(true);
    // Resolve org_id fresh — bypasses any stale cache
    const orgId = await resolveOrgId();

    let count = 0, skipped = 0;

    for (const row of rows) {
      const { _row, ...data } = row;

      // Inject context fields
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      if (orgId) data.org_id = orgId;
      
      // If we have a context propertyId, use it if the row's property_id is missing or not a UUID
      if (propertyId) {
        const rowPropId = String(data.property_id || '').trim();
        if (!rowPropId || !uuidRegex.test(rowPropId)) {
          data.property_id = propertyId;
        }
      }

      // If we have a context buildingId, use it
      if (buildingId) {
        const rowBldId = String(data.building_id || '').trim();
        if (!rowBldId || !uuidRegex.test(rowBldId)) {
          data.building_id = buildingId;
        }
      }

      // Relational strings: Strip fields that exist for the UI grid but don't map to DB columns.
      // These often contain human names ("Sunset Plaza") or placeholders ("1") that crash DB inserts.
      const relationalStrings = ['property_name', 'building_name', 'unit_id_code', 'property_id_code', 'total_sf', 'square_feet'];
      if (moduleType !== 'lease') {
        relationalStrings.push('tenant_name'); // 'leases' table HAS tenant_name
      }
      
      // For Units, 'square_footage' is a real DB column, but 'square_feet' (alias) is not.
      // For Buildings/Properties, 'total_sf' IS a real DB column.
      const dbColumns = (moduleType === 'building' || moduleType === 'property') ? ['total_sf'] : [];
      
      relationalStrings.forEach(f => {
        if (!dbColumns.includes(f)) delete data[f];
      });

      // Strip empty values and sensitive fields
      Object.keys(data).forEach(k => {
        if (data[k] === null || data[k] === undefined || data[k] === '') delete data[k];
      });

      // CRITICAL: Strip 'id' to prevent collisions during bulk import.
      // The system should generate unique IDs for each new record.
      delete data.id;

      try {
        await service.create(data);
        count++;
      } catch (err) {
        console.warn(`[BulkImportModal] Row ${_row} failed:`, err.message);
        skipped++;
      }
    }

    if (skipped > 0) {
      toast.warning(`Imported ${count}. ${skipped} rows failed — check console for details.`);
    } else {
      toast.success(`Successfully imported ${count} ${title}!`);
    }

    queryClient.invalidateQueries();
    setImporting(false);
    onClose(); reset();
  };

  const isAI = method === 'ai_gemini';

  return (
    <Dialog open={isOpen} onOpenChange={v => { if (!v) { onClose(); reset(); } }}>
      <DialogContent className="max-w-6xl max-h-[94vh] overflow-hidden flex flex-col p-0 gap-0">

        {/* ── Header ──────────────────────────────────────────── */}
        <DialogHeader className="px-6 py-4 border-b bg-gradient-to-r from-slate-50 to-white shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-base font-semibold">Bulk Import — {title}</DialogTitle>
              <DialogDescription className="text-xs text-slate-500 mt-0.5">
                Upload any format · Review & edit extracted fields · Import
              </DialogDescription>
            </div>
            {CSV_TEMPLATES?.[moduleType] && (
              <Button variant="outline" size="sm" onClick={() => downloadTemplate(moduleType)} className="text-xs h-8">
                <FileText className="w-3.5 h-3.5 mr-1.5 text-blue-500" />CSV Template
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* ── Body ────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">

          {/* Upload Zone */}
          {!rows && !loading && (
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center bg-slate-50/50 hover:border-blue-300 transition-colors">
              <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-semibold text-slate-700 mb-1">Upload Your Document</p>
              <p className="text-xs text-slate-400 mb-5">CSV · Excel · PDF · Word (.docx) · Plain text</p>
              <div className="flex justify-center flex-wrap gap-2 mb-6">
                {[{l:'CSV',c:'text-emerald-600',I:FileText},{l:'Excel',c:'text-green-700',I:FileSpreadsheet},
                  {l:'PDF',c:'text-red-500',I:FileType2},{l:'Word',c:'text-blue-600',I:FileType2},{l:'TXT',c:'text-slate-500',I:FileText}
                ].map(({l,c,I})=>(
                  <span key={l} className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white border border-slate-200 shadow-sm">
                    <I className={`w-3 h-3 ${c}`}/>{l}
                  </span>
                ))}
              </div>
              <label className="cursor-pointer">
                <input type="file" accept={ACCEPT_ATTR} className="hidden" onChange={handleFileUpload} />
                <Button asChild className="bg-blue-600 hover:bg-blue-700 h-9">
                  <span><Upload className="w-4 h-4 mr-2"/>Browse Files</span>
                </Button>
              </label>
              <p className="text-[10px] text-slate-400 mt-4 flex items-center justify-center gap-1">
                <Sparkles className="w-3 h-3 text-violet-400"/>PDF & Word → Google Gemini 1.5 Pro extraction
              </p>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              {file?.name?.match(/\.(pdf|docx|doc)$/i)
                ? <Sparkles className="w-8 h-8 text-violet-500 animate-pulse"/>
                : <Loader2 className="w-8 h-8 animate-spin text-blue-600"/>}
              <p className="text-sm font-medium text-slate-600">
                {file?.name?.match(/\.(pdf|docx|doc)$/i)
                  ? 'Gemini 1.5 Pro analyzing document…'
                  : 'Parsing file…'}
              </p>
              <p className="text-xs text-slate-400">{file?.name}</p>
            </div>
          )}

          {/* Edit Grid */}
          {rows && !loading && (
            <div className="space-y-3">

              {/* Status bar */}
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0"/>
                  <span className="text-sm font-semibold text-emerald-800">
                    {rows.length} record{rows.length !== 1 ? 's' : ''} from <span className="italic">{file?.name}</span>
                  </span>
                  {method && (
                    <Badge className={`text-[9px] font-bold px-1.5 py-0.5 ${methodBadgeClass(method)}`}>
                      {isAI && <Sparkles className="w-2.5 h-2.5 mr-0.5"/>}
                      {methodLabel(method)}
                    </Badge>
                  )}
                  {allErrors.length > 0 && (
                    <Badge className="text-[9px] font-bold px-1.5 py-0.5 bg-red-100 text-red-700">
                      <AlertCircle className="w-2.5 h-2.5 mr-0.5"/>
                      {allErrors.length} required field{allErrors.length > 1 ? 's' : ''} empty
                    </Badge>
                  )}
                </div>
                <label className="cursor-pointer shrink-0">
                  <input type="file" accept={ACCEPT_ATTR} className="hidden" onChange={handleFileUpload}/>
                  <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs text-slate-500">
                    <span><X className="w-3 h-3 mr-1"/>Change File</span>
                  </Button>
                </label>
              </div>

              {/* Validation banner */}
              {allErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0"/>
                  <div>
                    <p className="text-xs font-bold text-red-700">Fill required fields (shown in red) before importing</p>
                    {allErrors.slice(0, 4).map((e, i) => <p key={i} className="text-[11px] text-red-600">{e}</p>)}
                    {allErrors.length > 4 && <p className="text-[11px] text-red-400">…and {allErrors.length - 4} more</p>}
                  </div>
                </div>
              )}

              {/* Inline edit table */}
              <div className="border rounded-lg overflow-hidden shadow-sm">
                <div className="overflow-auto" style={{ maxHeight: '55vh' }}>
                  <table className="border-collapse text-xs w-full" style={{ minWidth: `${fieldDefs.length * 130 + 60}px` }}>
                    <thead className="sticky top-0 z-10 bg-slate-100">
                      <tr>
                        <th className="text-[10px] font-bold text-slate-400 px-2 py-2 text-left w-8 border-b border-r border-slate-200 sticky left-0 bg-slate-100">#</th>
                        {fieldDefs.map(f => (
                          <th key={f.key}
                            className="text-[10px] font-bold text-slate-600 uppercase px-2 py-2 text-left border-b border-r border-slate-200 whitespace-nowrap min-w-[120px]">
                            {f.label}
                            {f.required && <span className="text-red-500 ml-0.5">*</span>}
                          </th>
                        ))}
                        <th className="text-[10px] font-bold text-slate-400 px-2 py-2 border-b border-slate-200 w-8"/>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rIdx) => {
                        const rowErrors = getRowErrors(row);
                        const hasError  = rowErrors.length > 0;
                        return (
                          <tr key={rIdx}
                            className={[
                              'border-b border-slate-100 transition-colors',
                              hasError ? 'bg-red-50/40' : rIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30',
                            ].join(' ')}>
                            <td className="px-2 py-1 text-[10px] text-slate-400 font-mono border-r border-slate-200 sticky left-0 bg-inherit">{row._row}</td>
                            {fieldDefs.map(f => {
                              const isEmpty    = !row[f.key] && row[f.key] !== 0;
                              const isBad      = f.required && isEmpty;
                              return (
                                <td key={f.key} className="p-0.5 border-r border-slate-100">
                                  <EditableCell
                                    value={row[f.key]}
                                    placeholder={f.placeholder}
                                    isRequired={f.required}
                                    isEmpty={isEmpty}
                                    isBad={isBad}
                                    onChange={val => handleCellChange(rIdx, f.key, val)}
                                  />
                                </td>
                              );
                            })}
                            <td className="px-1 py-1 text-center">
                              <button onClick={() => removeRow(rIdx)}
                                title="Delete row"
                                className="text-slate-300 hover:text-red-500 text-base leading-none px-1 transition-colors">
                                ×
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Add row */}
                <div className="px-3 py-2 border-t bg-slate-50 flex items-center gap-3">
                  <button onClick={addRow}
                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 transition-colors">
                    + Add Row Manually
                  </button>
                  <span className="text-[10px] text-slate-400 ml-auto">{rows.length} total</span>
                </div>
              </div>

            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <DialogFooter className="px-6 py-3 border-t bg-slate-50 flex items-center gap-3 shrink-0">
          <Button variant="outline" onClick={() => { onClose(); reset(); }} disabled={importing}>Cancel</Button>
          {rows && (
            <>
              {allErrors.length > 0 && (
                <span className="text-[11px] text-red-600 flex-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3"/>Fill fields marked <span className="font-bold text-red-700">*</span> before importing
                </span>
              )}
              <Button
                onClick={executeImport}
                disabled={!canImport}
                className={`min-w-[160px] ${canImport ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300 cursor-not-allowed text-slate-500'}`}
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2"/>Importing…</>
                  : <><span className="mr-1">↓</span>Import {rows.length} Record{rows.length !== 1 ? 's' : ''}</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
