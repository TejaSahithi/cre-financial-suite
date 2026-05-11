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
import { CSV_TEMPLATES, parseCSV } from "@/services/parsingEngine";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction, invokeEdgeFunctionFormData } from "@/services/edgeFunctions";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import {
  BuildingService, UnitService, RevenueService, ExpenseService,
  PropertyService, LeaseService, TenantService, GLAccountService, InvoiceService, VendorService,
} from "@/services/api";

// ── Service map ──────────────────────────────────────────────────────────────
const SERVICE_MAP = {
  building: BuildingService, unit: UnitService,
  revenue: RevenueService,   expense: ExpenseService,
  property: PropertyService, lease: LeaseService,
  tenant: TenantService,     invoice: InvoiceService,
  gl_account: GLAccountService, gl: GLAccountService,
  vendor: VendorService,
};

const MODULE_TITLES = {
  property: 'Properties', building: 'Buildings', unit: 'Units',
  lease: 'Leases', tenant: 'Tenants', revenue: 'Revenue Entries',
  expense: 'Expenses', invoice: 'Invoices',
  gl_account: 'GL Accounts', gl: 'GL Accounts',
  vendor: 'Vendors',
};

// ── All fields per module — shown in the edit grid ──────────────────────────
// { key, label, required, placeholder }
const MODULE_FIELDS = {
  property: [
    { key: 'property_id_code', label: 'Property ID',   required: false, placeholder: 'PROP-1001' },
    { key: 'name',           label: 'Property Name',  required: true,  placeholder: 'e.g. Sunset Plaza' },
    { key: 'address',        label: 'Address',         required: false, placeholder: '123 Main St' },
    { key: 'city',           label: 'City',            required: false, placeholder: 'Phoenix' },
    { key: 'state',          label: 'State',           required: false, placeholder: 'AZ' },
    { key: 'zip',            label: 'ZIP',             required: false, placeholder: '85001' },
    { key: 'property_type',  label: 'Type',            required: false, placeholder: 'office / retail / industrial…' },
    { key: 'structure_type', label: 'Structure',       required: false, placeholder: 'single / multi' },
    { key: 'total_sf',       label: 'Total SF',        required: false, placeholder: '50000' },
    { key: 'leased_sf',      label: 'Leased SF',       required: false, placeholder: '45000' },
    { key: 'total_buildings',label: 'Buildings',       required: false, placeholder: '1' },
    { key: 'total_units',    label: 'Units',           required: false, placeholder: '10' },
    { key: 'occupancy_pct',  label: 'Occupancy %',     required: false, placeholder: '90' },
    { key: 'floors',         label: 'Floors',          required: false, placeholder: '5' },
    { key: 'year_built',     label: 'Year Built',      required: false, placeholder: '1998' },
    { key: 'status',         label: 'Status',          required: false, placeholder: 'active' },
    { key: 'purchase_price', label: 'Purchase Price',  required: false, placeholder: '5000000' },
    { key: 'market_value',   label: 'Market Value',    required: false, placeholder: '6000000' },
    { key: 'noi',            label: 'NOI (Annual)',     required: false, placeholder: '350000' },
    { key: 'cap_rate',       label: 'Cap Rate %',      required: false, placeholder: '5.5' },
    { key: 'manager',        label: 'Property Manager',required: false, placeholder: 'Manager name' },
    { key: 'owner',          label: 'Owner',           required: false, placeholder: 'Owner / entity' },
    { key: 'contact',        label: 'Contact',         required: false, placeholder: 'Phone / email' },
    { key: 'phone',          label: 'Phone',           required: false, placeholder: '(716) 555-0148' },
    { key: 'email',          label: 'Email',           required: false, placeholder: 'manager@example.com' },
    { key: 'acquired_date',  label: 'Acquired Date',   required: false, placeholder: 'YYYY-MM-DD' },
    { key: 'parcel_tax_id',  label: 'Parcel / Tax ID', required: false, placeholder: '110.42-3-15' },
    { key: 'parking_spaces', label: 'Parking Spaces',  required: false, placeholder: '102' },
    { key: 'amenities',      label: 'Amenities',       required: false, placeholder: 'Pool; Gym' },
    { key: 'insurance_policy', label: 'Insurance Policy', required: false, placeholder: 'INS-NY-44018' },
    { key: 'notes',          label: 'Notes',           required: false, placeholder: 'Additional info…' },
  ],
  building: [
    { key: 'property_id',      label: 'Property UUID',    required: false, placeholder: 'Auto / existing UUID' },
    { key: 'property_name',    label: 'Parent Property', required: false, placeholder: 'Sunset Plaza' },
    { key: 'property_id_code', label: 'Property ID',      required: false, placeholder: 'PROP-1001' },
    { key: 'building_id_code', label: 'Building ID',      required: false, placeholder: 'BLDG-2001' },
    { key: 'name',       label: 'Building Name', required: true,  placeholder: 'Building A' },
    { key: 'address',    label: 'Address',       required: false, placeholder: '123 Main St' },
    { key: 'total_sf',   label: 'Total SF',      required: false, placeholder: '50000' },
    { key: 'floors',     label: 'Floors',        required: false, placeholder: '5' },
    { key: 'year_built', label: 'Year Built',    required: false, placeholder: '1998' },
    { key: 'status',     label: 'Status',        required: false, placeholder: 'active' },
  ],
  unit: [
    { key: 'property_id',      label: 'Property UUID',    required: false, placeholder: 'Auto / existing UUID' },
    { key: 'property_name',    label: 'Parent Property', required: false, placeholder: 'Sunset Plaza' },
    { key: 'property_id_code', label: 'Property ID',      required: false, placeholder: 'PROP-1001' },
    { key: 'building_id',      label: 'Building UUID',    required: false, placeholder: 'Auto / existing UUID' },
    { key: 'building_name',    label: 'Parent Building', required: false, placeholder: 'Tower A' },
    { key: 'building_id_code', label: 'Building ID',      required: false, placeholder: 'BLDG-2001' },
    { key: 'unit_id_code',    label: 'Unit ID',        required: false, placeholder: 'UNIT-3001' },
    { key: 'unit_number',    label: 'Unit #',        required: true,  placeholder: '101' },
    { key: 'bedroom_bathroom', label: 'Bed/Bath',     required: false, placeholder: '2 / 1' },
    { key: 'floor',          label: 'Floor',         required: false, placeholder: '1' },
    { key: 'square_footage', label: 'Square Feet',   required: false, placeholder: '1200' },
    { key: 'unit_type',      label: 'Unit Type',     required: false, placeholder: 'office' },
    { key: 'occupancy_status', label: 'Status',        required: false, placeholder: 'vacant / occupied' },
    { key: 'monthly_rent',   label: 'Monthly Rent',  required: false, placeholder: '2500' },
    { key: 'tenant_name',    label: 'Tenant Name',   required: false, placeholder: 'Acme Corp' },
    { key: 'lease_start',    label: 'Lease Start',   required: false, placeholder: 'YYYY-MM-DD' },
    { key: 'lease_end',      label: 'Lease End',     required: false, placeholder: 'YYYY-MM-DD' },
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
    { key: 'square_footage',   label: 'Leased SF',      required: false, placeholder: '2400' },
    { key: 'lease_type',       label: 'Lease Type',     required: false, placeholder: 'nnn / gross / modified_gross' },
    { key: 'security_deposit', label: 'Security Dep.',  required: false, placeholder: '10000' },
    { key: 'cam_amount',       label: 'CAM (Annual)',   required: false, placeholder: '5000' },
    { key: 'escalation_rate',  label: 'Escalation %',  required: false, placeholder: '3' },
    { key: 'renewal_options',  label: 'Renewal Options',required: false, placeholder: '2×5yr options' },
    { key: 'ti_allowance',     label: 'TI Allowance',  required: false, placeholder: '25000' },
    { key: 'free_rent_months', label: 'Free Rent (mo.)',required: false, placeholder: '2' },
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
  vendor: [
    { key: 'name',          label: 'Vendor Name',  required: true,  placeholder: 'ABC Services' },
    { key: 'contact_name',  label: 'Contact Name', required: false, placeholder: 'Jane Smith' },
    { key: 'contact_email', label: 'Email',        required: false, placeholder: 'jane@abcservices.com' },
    { key: 'contact_phone', label: 'Phone',        required: false, placeholder: '555-0100' },
    { key: 'category',      label: 'Category',     required: false, placeholder: 'maintenance' },
    { key: 'status',        label: 'Status',       required: false, placeholder: 'active' },
  ],
  invoice: [
    { key: 'tenant_name',    label: 'Tenant',       required: false, placeholder: 'Acme Corp' },
    { key: 'property_name',  label: 'Property',     required: false, placeholder: 'Sunset Plaza' },
    { key: 'invoice_number', label: 'Invoice #',    required: false, placeholder: 'INV-202604-001' },
    { key: 'billing_period', label: 'Period',       required: false, placeholder: '2026-04' },
    { key: 'issued_date',    label: 'Issued Date',  required: false, placeholder: 'YYYY-MM-DD' },
    { key: 'due_date',       label: 'Due Date',     required: false, placeholder: 'YYYY-MM-DD' },
    { key: 'amount',         label: 'Amount ($)',   required: true,  placeholder: '1250.00' },
    { key: 'status',         label: 'Status',       required: false, placeholder: 'pending' },
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

const ACCEPT_ATTR = '.csv,.tsv,.xlsx,.xls,.pdf,.docx,.doc,.txt,.jpg,.jpeg,.png,.tif,.tiff,.webp,.bmp,.gif';
const LOCAL_ONLY_MODULES = new Set(['vendor']);

const PIPELINE_MODULE_MAP = {
  property: 'properties',
  building: 'buildings',
  unit: 'units',
  lease: 'leases',
  tenant: 'tenants',
  revenue: 'revenue',
  expense: 'expenses',
  invoice: 'invoices',
  gl_account: 'gl_accounts',
  gl: 'gl_accounts',
};

function methodLabel(method) {
  const labels = {
    canonical_pipeline: 'Canonical Pipeline',
    review_required: 'Review Required',
    docling: 'Docling',
    gemini_vision: 'Gemini Vision OCR',
    hybrid: 'Hybrid OCR',
    csv: 'CSV Parser',
    excel: 'Excel Parser',
  };
  return labels[method] || (method ? String(method).replace(/_/g, ' ') : 'Pipeline');
}

function methodBadgeClass(method) {
  if (method === 'review_required') return 'bg-amber-100 text-amber-700 border-amber-200';
  if (['gemini_vision', 'hybrid'].includes(method)) return 'bg-purple-100 text-purple-700 border-purple-200';
  return 'bg-blue-100 text-blue-700 border-blue-200';
}

function fieldValue(entry) {
  if (entry == null) return null;
  if (typeof entry !== 'object') return entry;
  if ('value' in entry) return entry.value;
  if ('display_value' in entry) return entry.display_value;
  if ('raw_value' in entry) return entry.raw_value;
  return null;
}

function normalizeFieldKey(key) {
  return String(key || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizePropertyStructureType(value) {
  const normalized = normalizeFieldKey(value);
  if (!normalized) return null;
  if (
    normalized === 'multi' ||
    normalized.includes('multi_building') ||
    normalized.includes('multi_tenant') ||
    normalized.startsWith('multi')
  ) {
    return 'multi';
  }
  if (
    normalized === 'single' ||
    normalized.includes('single_building') ||
    normalized.startsWith('single')
  ) {
    return 'single';
  }
  return normalized;
}

async function parseStructuredFileLocally(file) {
  const ext = String(file?.name || '').split('.').pop()?.toLowerCase() || '';

  if (ext === 'xlsx' || ext === 'xls') {
    const { read, utils } = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = read(buffer, { type: 'array' });
    const firstSheet = workbook.SheetNames?.[0];
    if (!firstSheet) {
      throw new Error('Excel file contains no worksheets.');
    }
    return parseCSV(utils.sheet_to_csv(workbook.Sheets[firstSheet], { blankrows: false })).rows;
  }

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    const normalizedText = ext === 'tsv' ? text.replace(/\t/g, ',') : text;
    return parseCSV(normalizedText).rows;
  }

  throw new Error('This import expects a CSV, TSV, or Excel file.');
}

// Detects whether a record is a plain CSV-row object (no pipeline-wrapper keys).
// CSV parsed_data rows are stored as flat objects like { name: 'X', city: 'Y' }.
function isPlainDataRow(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const pipelineKeys = new Set(['values', 'row', 'fields', 'standard_fields', 'custom_fields',
    'extracted_fields', 'record_index', 'row_index', 'confidence', 'warnings', 'notes',
    'missing_required', 'rejected_fields']);
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  // A plain row has NO pipeline-wrapper keys (it's all data columns + optional _row_number)
  return !keys.some(k => pipelineKeys.has(k));
}

function rowFromReviewRecord(record) {
  if (!record || typeof record !== 'object') return null;

  // ── Plain CSV row (e.g. from parse-file pipeline) ──────────────────────────
  // parsed_data/valid_data for CSV files are stored as arrays of flat objects.
  // They have NO pipeline wrapper keys, so we return them directly after
  // stripping internal metadata keys (_row_number, _row, etc.).
  if (isPlainDataRow(record)) {
    const cleaned = {};
    Object.entries(record).forEach(([k, v]) => {
      if (k.startsWith('_')) return; // skip internal metadata (_row_number, etc.)
      if (v == null) return;
      cleaned[normalizeFieldKey(k)] = v;
    });
    return Object.keys(cleaned).length ? cleaned : null;
  }

  // ── Review-pipeline wrapper formats ───────────────────────────────────────
  if (record.values && typeof record.values === 'object') return record.values;
  if (record.row && typeof record.row === 'object') return record.row;

  const output = {};
  const addField = (key, entry) => {
    const normalizedKey = normalizeFieldKey(key);
    if (!normalizedKey) return;
    if (entry?.status === 'rejected' || entry?.accepted === false || entry?.rejected === true) return;
    const value = fieldValue(entry);
    if (value == null || value === '') return;
    output[normalizedKey] = value;
  };

  if (record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)) {
    Object.entries(record.fields).forEach(([key, entry]) => addField(key, entry));
  }

  const addArrayField = (entry) => {
    const key = entry?.field_key || entry?.key || entry?.name || entry?.label;
    addField(key, entry);
  };
  if (Array.isArray(record.standard_fields)) record.standard_fields.forEach(addArrayField);
  if (Array.isArray(record.custom_fields)) record.custom_fields.forEach(addArrayField);
  if (Array.isArray(record.extracted_fields)) record.extracted_fields.forEach(addArrayField);

  return Object.keys(output).length ? output : null;
}

function extractRowsFromUploadedFile(record) {
  // Priority: parsed_data first for defer_store=true flows (CSV/Excel)
  // where valid_data is empty because validate-data was skipped.
  const candidates = [
    record?.valid_data,
    record?.parsed_data,
    record?.normalized_output?.records,
    record?.normalized_output?.rows,
    record?.ui_review_payload?.records,
    record?.ui_review_payload?.rows,
    record?.reviewed_output?.final_records,
    record?.reviewed_output?.records,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const rows = candidate.map(rowFromReviewRecord).filter(Boolean);
    if (rows.length) return rows;
  }

  const singleRecord = rowFromReviewRecord(record?.ui_review_payload?.record || record?.normalized_output?.record);
  return singleRecord ? [singleRecord] : [];
}

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

// Modules whose DB row REQUIRES a property_id (NOT NULL FK).
// Buildings/units may resolve their parent scope per row from extracted
// property/building names/codes, so they do not need one global picker.
const REQUIRES_PROPERTY = new Set(['building', 'unit']);
const CAN_RESOLVE_PROPERTY_PER_ROW = new Set(['building', 'unit']);
const DEFER_STORE_MODULES = new Set(['property', 'building', 'unit']);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function BulkImportModal({
  isOpen,
  onClose,
  moduleType,
  orgId: contextOrgId,
  portfolioId,
  propertyId,
  buildingId,
  unitId,
}) {
  const queryClient = useQueryClient();
  const [file, setFile]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // rows: array of plain objects keyed by field key
  const [rows, setRows]       = useState(null);
  const [method, setMethod]   = useState(null);
  const [pipelineFileId, setPipelineFileId] = useState(null);
  const [pipelineReviewRequired, setPipelineReviewRequired] = useState(false);
  const [pipelineStored, setPipelineStored] = useState(false);
  // Target property selected inside the modal (only used when no contextual propertyId)
  const [targetPropertyId, setTargetPropertyId] = useState('');
  const [propertyOptions, setPropertyOptions] = useState([]);
  const [buildingOptions, setBuildingOptions] = useState([]);
  const [selectedPropertyAddress, setSelectedPropertyAddress] = useState("");

  const title   = MODULE_TITLES[moduleType] || moduleType;
  const service = SERVICE_MAP[moduleType];
  const fieldDefs = MODULE_FIELDS[moduleType] ?? [];
  const requiredFields = fieldDefs.filter(f => f.required).map(f => f.key);

  // The property_id we'll attach to each row (context wins over modal selection)
  const effectivePropertyId = propertyId || targetPropertyId || null;
  const needsPropertyPick =
    REQUIRES_PROPERTY.has(moduleType) &&
    !propertyId &&
    !CAN_RESOLVE_PROPERTY_PER_ROW.has(moduleType);
  const canUseOptionalPropertyPick =
    REQUIRES_PROPERTY.has(moduleType) &&
    !propertyId &&
    CAN_RESOLVE_PROPERTY_PER_ROW.has(moduleType);

  // Load property options for the in-modal picker (only when needed)
  useEffect(() => {
    if (!isOpen || (!needsPropertyPick && !canUseOptionalPropertyPick)) return;
    let cancelled = false;
    PropertyService.list().then(list => {
      if (cancelled) return;
      setPropertyOptions(Array.isArray(list) ? list : []);
    }).catch(() => { if (!cancelled) setPropertyOptions([]); });
    return () => { cancelled = true; };
  }, [isOpen, needsPropertyPick, canUseOptionalPropertyPick]);

  useEffect(() => {
    if (!isOpen || moduleType !== 'unit') return;
    let cancelled = false;
    BuildingService.list().then(list => {
      if (cancelled) return;
      setBuildingOptions(Array.isArray(list) ? list : []);
    }).catch(() => { if (!cancelled) setBuildingOptions([]); });
    return () => { cancelled = true; };
  }, [isOpen, moduleType]);

  useEffect(() => {
    let cancelled = false;

    const loadSelectedPropertyAddress = async () => {
      const selectedId = propertyId || targetPropertyId;
      if (!selectedId) {
        setSelectedPropertyAddress("");
        return;
      }

      const cachedProperty = propertyOptions.find((property) => property.id === selectedId);
      if (cachedProperty) {
        if (!cancelled) setSelectedPropertyAddress(cachedProperty.address || "");
        return;
      }

      try {
        const matches = await PropertyService.filter({ id: selectedId });
        if (!cancelled) {
          setSelectedPropertyAddress(matches?.[0]?.address || "");
        }
      } catch {
        if (!cancelled) setSelectedPropertyAddress("");
      }
    };

    loadSelectedPropertyAddress();
    return () => { cancelled = true; };
  }, [propertyId, targetPropertyId, propertyOptions]);

  const reset = () => {
    setRows(null);
    setFile(null);
    setMethod(null);
    setTargetPropertyId('');
    setPipelineFileId(null);
    setPipelineReviewRequired(false);
    setPipelineStored(false);
  };

  // ── Merge extracted rows with full field template ─────────────────────────
  const buildRows = useCallback((extractedRows) => {
    const defaultRow = Object.fromEntries(fieldDefs.map(f => [f.key, null]));
    const allowedKeys = new Set(fieldDefs.map(f => f.key));

    // Per-module key aliases — normalize alternative names the AI / CSV may
    // produce so they map to our canonical MODULE_FIELDS key before the
    // strict filter below would otherwise drop them.
    const ALIAS_MAP = {
      property: {
        // Name
        property_id: 'property_id_code', property_code: 'property_id_code', asset_id: 'property_id_code',
        property_uuid: 'property_id_code', prop_id: 'property_id_code', id_code: 'property_id_code',
        property: 'name', property_name: 'name', building_name: 'name', asset_name: 'name',
        asset: 'name', project_name: 'name', site_name: 'name',
        // SF
        total_sqft: 'total_sf', total_square_feet: 'total_sf', square_footage: 'total_sf',
        square_feet: 'total_sf', sqft: 'total_sf', sf: 'total_sf',
        rentable_sf: 'total_sf', rentable_square_feet: 'total_sf',
        gla: 'total_sf', gross_leasable_area: 'total_sf', nra: 'total_sf',
        leased_sqft: 'leased_sf', occupied_sf: 'leased_sf', occupied_sqft: 'leased_sf',
        // Address
        property_address: 'address', premises_address: 'address', mailing_address: 'address',
        address_line_1: 'address', address1: 'address', street: 'address',
        street_address: 'address', location: 'address', full_address: 'address',
        municipality: 'city', town: 'city',
        province: 'state', region: 'state',
        zipcode: 'zip', zip_code: 'zip', postal_code: 'zip', postal: 'zip',
        // Type
        type: 'property_type', asset_type: 'property_type', building_type: 'property_type',
        use_type: 'property_type', property_use: 'property_type', class: 'property_type',
        structure: 'structure_type', structure_category: 'structure_type', building_structure: 'structure_type',
        // Counts
        units: 'total_units', unit_count: 'total_units', number_of_units: 'total_units',
        buildings: 'total_buildings', building_count: 'total_buildings', number_of_buildings: 'total_buildings',
        occupancy: 'occupancy_pct', occupancy_rate: 'occupancy_pct', occupancy_percent: 'occupancy_pct',
        occ_pct: 'occupancy_pct',
        floor_count: 'floors', number_of_floors: 'floors', stories: 'floors', num_floors: 'floors',
        // Year
        built: 'year_built', construction_year: 'year_built', year_constructed: 'year_built',
        year: 'year_built',
        // Value / performance
        acquisition_price: 'purchase_price', cost_basis: 'purchase_price',
        appraised_value: 'market_value', current_value: 'market_value', assessed_value: 'market_value',
        valuation: 'market_value',
        net_operating_income: 'noi', annual_noi: 'noi',
        capitalization_rate: 'cap_rate',
        // Owner / manager
        property_manager: 'manager', manager_name: 'manager', managed_by: 'manager',
        owner_name: 'owner', ownership: 'owner', owner_entity: 'owner',
        property_contact: 'contact', contact_name: 'contact', contact_info: 'contact',
        telephone: 'phone', phone_number: 'phone', contact_phone: 'phone',
        email_address: 'email', contact_email: 'email',
        acquisition_date: 'acquired_date', purchase_date: 'acquired_date', date_acquired: 'acquired_date',
        parcel_id: 'parcel_tax_id', tax_id: 'parcel_tax_id', parcel_tax: 'parcel_tax_id',
        parking: 'parking_spaces', parking_count: 'parking_spaces',
        features: 'amenities', amenity_list: 'amenities',
        policy_number: 'insurance_policy', insurance: 'insurance_policy',
        // Status
        asset_status: 'status', property_status: 'status',
      },
      building: {
        property_id: 'property_id',
        property: 'property_name', property_name: 'property_name', parent_property: 'property_name',
        parent_property_name: 'property_name', asset_property: 'property_name', site_name: 'property_name',
        property_code: 'property_id_code', property_id_code: 'property_id_code', parent_property_id: 'property_id_code',
        building_id: 'building_id_code', building_code: 'building_id_code', building_id_code: 'building_id_code',
        building_name: 'name', asset_name: 'name', building: 'name',
        total_sqft: 'total_sf', square_feet: 'total_sf', sqft: 'total_sf',
        street: 'address', location: 'address',
        built: 'year_built',
        building_status: 'status', asset_status: 'status',
      },
      unit: {
        // Parent scope
        property_id: 'property_id', property_uuid: 'property_id', parent_property_id: 'property_id_code',
        property_code: 'property_id_code', property_id_code: 'property_id_code',
        property: 'property_name', property_name: 'property_name', parent_property: 'property_name',
        building_id: 'building_id', building_uuid: 'building_id', parent_building_id: 'building_id_code',
        building_code: 'building_id_code', building_id_code: 'building_id_code',
        building: 'building_name', building_name: 'building_name', parent_building: 'building_name',
        unit_id: 'unit_id_code', unit_code: 'unit_id_code',
        // Unit number
        suite: 'unit_number', suite_number: 'unit_number', space: 'unit_number', space_number: 'unit_number',
        unit_no: 'unit_number', unit_no_: 'unit_number',
        unit_number: 'unit_number',
        // Bed/bath
        bed_bath: 'bedroom_bathroom', beds_baths: 'bedroom_bathroom', bedroom_bathroom: 'bedroom_bathroom',
        // SF
        total_sf: 'square_footage', total_sqft: 'square_footage', square_feet: 'square_footage',
        sqft: 'square_footage', sq_ft: 'square_footage', rsf: 'square_footage', rentable_sf: 'square_footage',
        // Status
        status: 'occupancy_status', lease_status: 'occupancy_status', occupancy: 'occupancy_status', availability: 'occupancy_status',
        // Rent
        rent: 'monthly_rent', market_rent: 'monthly_rent', base_rent: 'monthly_rent', rent_per_month: 'monthly_rent',
        // Type
        type: 'unit_type',
        // Lease dates
        lease_start: 'lease_start', start_date: 'lease_start', lease_end: 'lease_end', end_date: 'lease_end',
      },
      lease: {
        // Tenant
        tenant: 'tenant_name', lessee: 'tenant_name', occupant: 'tenant_name', company: 'tenant_name',
        // Property / unit
        property: 'property_name', building: 'property_name', premises: 'property_name',
        suite: 'unit_number', suite_number: 'unit_number', space: 'unit_number',
        // SF
        total_sf: 'square_footage', total_sqft: 'square_footage', square_feet: 'square_footage',
        sqft: 'square_footage', leased_sf: 'square_footage', rentable_sf: 'square_footage', rsf: 'square_footage', area: 'square_footage',
        // Dates
        commencement_date: 'start_date', commence: 'start_date', effective_date: 'start_date',
        expiration_date: 'end_date', termination_date: 'end_date', expiry: 'end_date',
        // Rent
        rent: 'monthly_rent', base_rent: 'monthly_rent', rent_per_month: 'monthly_rent', base_monthly_rent: 'monthly_rent',
        annual_base_rent: 'annual_rent', base_rent_per_year: 'annual_rent', yearly_rent: 'annual_rent',
        // CAM / Deposit / TI
        cam: 'cam_amount', cam_charges: 'cam_amount', operating_expenses: 'cam_amount',
        deposit: 'security_deposit', security: 'security_deposit',
        ti: 'ti_allowance', tenant_improvement: 'ti_allowance', tenant_improvement_allowance: 'ti_allowance',
        free_rent: 'free_rent_months', abatement_months: 'free_rent_months', rent_abatement_months: 'free_rent_months',
        // Escalation
        rent_escalation: 'escalation_rate', annual_escalation: 'escalation_rate', cpi_adjustment: 'escalation_rate',
        // Renewal
        renewal: 'renewal_options', option_to_renew: 'renewal_options',
        // Type
        type: 'lease_type',
      },
      tenant: {
        // Name
        tenant_name: 'name', company_name: 'name', entity_name: 'name', business_name: 'name',
        // Contact
        contact: 'contact_name', primary_contact: 'contact_name', contact_person: 'contact_name',
        // Phone
        phone_number: 'phone', telephone: 'phone', mobile: 'phone', cell: 'phone',
        // Other
        sector: 'industry', business_type: 'industry',
        credit_score: 'credit_rating', credit: 'credit_rating',
        tenant_status: 'status',
      },
      vendor: {
        vendor_name: 'name', supplier_name: 'name', contractor_name: 'name', company_name: 'name',
        contact: 'contact_name', contact_person: 'contact_name', primary_contact: 'contact_name',
        email: 'contact_email', email_address: 'contact_email', contact_email: 'contact_email',
        phone: 'contact_phone', phone_number: 'contact_phone', telephone: 'contact_phone', contact_phone: 'contact_phone',
        vendor_category: 'category', service_category: 'category',
        vendor_status: 'status',
      },
      invoice: {
        total_amount: 'amount', total: 'amount', amount_due: 'amount', balance_due: 'amount', invoice_total: 'amount',
        invoice_date: 'issued_date', date_issued: 'issued_date', date: 'issued_date',
        payment_due: 'due_date', due: 'due_date',
        invoice_no: 'invoice_number', inv_number: 'invoice_number', invoice_num: 'invoice_number',
        period: 'billing_period', billing_month: 'billing_period',
        tenant: 'tenant_name', property: 'property_name',
        invoice_status: 'status',
      },
      expense: {
        expense_date: 'date', transaction_date: 'date', paid_date: 'date',
        expense_amount: 'amount', total_amount: 'amount', cost: 'amount',
        expense_category: 'category', type: 'category',
        vendor_name: 'vendor', payee: 'vendor', supplier: 'vendor',
        expense_description: 'description', detail: 'description',
        recovery_type: 'classification', recoverable: 'classification',
        gl_account: 'gl_code', account_code: 'gl_code', account: 'gl_code',
        property: 'property_name', building: 'property_name',
        year: 'fiscal_year',
      },
      revenue: {
        revenue_amount: 'amount', payment_amount: 'amount', total: 'amount', income: 'amount',
        revenue_date: 'date', payment_date: 'date', received_date: 'date',
        revenue_type: 'type', income_type: 'type',
        property: 'property_name', building: 'property_name',
        tenant: 'tenant_name', lessee: 'tenant_name',
        year: 'fiscal_year',
      },
    };
    const aliases = ALIAS_MAP[moduleType] || {};

    return extractedRows.map((extracted, idx) => {
      // 1. Apply per-module aliases (without overwriting an existing canonical value)
      const aliased = {};
      Object.entries(extracted).forEach(([k, v]) => {
        const sourceKey = normalizeFieldKey(k);
        const targetKey = aliases[sourceKey] || sourceKey;
        if (aliased[targetKey] === undefined || aliased[targetKey] === null) {
          aliased[targetKey] = v;
        }
      });

      // 2. STRICT FILTER: Only keep fields explicitly defined in MODULE_FIELDS for this specific module
      const filteredExtracted = Object.fromEntries(
        Object.entries(aliased).filter(([k]) => allowedKeys.has(k))
      );

      if (moduleType === 'property') {
        if (filteredExtracted.structure_type != null) {
          filteredExtracted.structure_type = normalizePropertyStructureType(filteredExtracted.structure_type);
        }
        if (filteredExtracted.property_type != null) {
          filteredExtracted.property_type = normalizeFieldKey(filteredExtracted.property_type);
        }
        if (filteredExtracted.status != null) {
          filteredExtracted.status = normalizeFieldKey(filteredExtracted.status);
        }
      }

      return {
        ...defaultRow,
        ...filteredExtracted,
        _row: idx + 1,
      };
    });
  }, [fieldDefs, moduleType]);

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFileUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    setRows(null);
    setMethod(null);
    setPipelineFileId(null);
    setPipelineReviewRequired(false);
    setPipelineStored(false);
    setFile(f);
    setLoading(true);

    try {
      if (REQUIRES_PROPERTY.has(moduleType) && !propertyId && !targetPropertyId && !CAN_RESOLVE_PROPERTY_PER_ROW.has(moduleType)) {
        toast.error('Pick a target property before uploading this file.');
        return;
      }

      if (LOCAL_ONLY_MODULES.has(moduleType)) {
        const extractedRows = await parseStructuredFileLocally(f);
        if (!extractedRows.length) {
          toast.warning('No records found. Try a different file or format.');
          return;
        }

        const fileName = String(f.name || '').toLowerCase();
        const localMethod =
          fileName.endsWith('.xlsx') || fileName.endsWith('.xls') ? 'excel' : 'csv';

        setRows(buildRows(extractedRows));
        setMethod(localMethod);
        toast.success(`${extractedRows.length} ${title.toLowerCase()} record${extractedRows.length !== 1 ? 's' : ''} extracted locally. Review and click Import to add them.`);
        return;
      }

      const canonicalModuleType = PIPELINE_MODULE_MAP[moduleType];
      if (!canonicalModuleType) {
        throw new Error(`Unsupported import module: ${moduleType}`);
      }

      const formData = new FormData();
      formData.append('file', f);
      formData.append('file_type', canonicalModuleType);
      const uploadPropertyId = propertyId || targetPropertyId;
      if (uploadPropertyId) formData.append('property_id', uploadPropertyId);

      const uploadData = await invokeEdgeFunctionFormData('upload-handler', formData);
      if (uploadData?.error) throw new Error(uploadData.message || 'Upload failed.');
      if (!uploadData?.file_id) throw new Error('Upload completed without a file_id.');

      const ingestData = await invokeEdgeFunction('ingest-file', {
        file_id: uploadData.file_id,
        module_type: canonicalModuleType,
        defer_store: DEFER_STORE_MODULES.has(moduleType),
      });
      if (ingestData?.error) {
        throw new Error(
          ingestData?.steps?.storage?.error ||
          ingestData?.steps?.validation?.error ||
          ingestData?.steps?.normalization?.error ||
          ingestData?.steps?.parsing?.error ||
          ingestData?.error_details ||
          'Ingestion failed.'
        );
      }

      const { data: fileRecord, error: recordError } = await supabase
        .from('uploaded_files')
        .select('*')
        .eq('id', uploadData.file_id)
        .single();
      if (recordError) throw recordError;
      if (fileRecord?.status === 'failed') throw new Error(fileRecord.error_message || 'Pipeline failed.');

      const extractedRows = extractRowsFromUploadedFile(fileRecord);
      if (!extractedRows.length) {
        toast.warning('No records found. Try a different file or format.');
        return;
      }
      const reviewRequired = fileRecord.status === 'review_required' || fileRecord.review_required === true;
      const stored =
        ingestData?.steps?.storage?.success ||
        ['stored', 'computing', 'completed'].includes(fileRecord.status);

      const isLocalReviewImport = DEFER_STORE_MODULES.has(moduleType);

      setRows(buildRows(extractedRows));
      setMethod(reviewRequired ? 'review_required' : (fileRecord.extraction_method || 'canonical_pipeline'));
      setPipelineFileId(isLocalReviewImport ? null : uploadData.file_id);
      setPipelineReviewRequired(isLocalReviewImport ? false : reviewRequired);
      setPipelineStored(isLocalReviewImport ? false : Boolean(stored) && !reviewRequired);

      if (reviewRequired) {
        toast.warning(`${extractedRows.length} record${extractedRows.length !== 1 ? 's' : ''} extracted and waiting for review approval.`);
      } else if (isLocalReviewImport) {
        toast.success(`${extractedRows.length} ${title.toLowerCase()} record${extractedRows.length !== 1 ? 's' : ''} extracted. Review and click Import to add them.`);
      } else if (stored) {
        toast.success(`${extractedRows.length} record${extractedRows.length !== 1 ? 's' : ''} imported through the canonical pipeline.`);
      } else {
        toast.success(`${extractedRows.length} record${extractedRows.length !== 1 ? 's' : ''} extracted. Review and edit below.`);
      }
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

  // Block import if this module needs a property and the user hasn't picked one yet
  const rowHasPropertyReference = (row) => {
    if (!row) return false;
    return Boolean(
      String(row.property_id || '').trim() ||
      String(row.property_id_code || '').trim() ||
      String(row.property_name || '').trim()
    );
  };

  const rowHasBuildingReference = (row) => {
    if (!row) return false;
    return Boolean(
      String(row.building_id || '').trim() ||
      String(row.building_id_code || '').trim() ||
      String(row.building_name || '').trim()
    );
  };

  const rowsMissingPropertyReference =
    ['building', 'unit'].includes(moduleType) &&
    !effectivePropertyId &&
    Array.isArray(rows)
      ? rows.filter(row => {
          if (moduleType === 'unit' && rowHasBuildingReference(row)) return false;
          return !rowHasPropertyReference(row);
        }).length
      : 0;

  const rowsMissingBuildingReference =
    moduleType === 'unit' &&
    !buildingId &&
    Array.isArray(rows)
      ? rows.filter(row => !rowHasBuildingReference(row)).length
      : 0;

  const missingTargetProperty = needsPropertyPick && !effectivePropertyId;
  const missingRowPropertyReference = rowsMissingPropertyReference > 0;
  const missingRowBuildingReference = rowsMissingBuildingReference > 0;

  const canImport =
    rows &&
    rows.length > 0 &&
    allErrors.length === 0 &&
    !importing &&
    !missingTargetProperty &&
    !missingRowPropertyReference &&
    !missingRowBuildingReference;
  const hasMismatchedBuildingAddresses =
    moduleType === "building" &&
    !!selectedPropertyAddress &&
    Array.isArray(rows) &&
    rows.some((row) => {
      const rowAddress = String(row.address || "").trim();
      return !rowAddress || rowAddress !== selectedPropertyAddress;
    });

  const autofillBuildingAddressesFromProperty = () => {
    if (!selectedPropertyAddress || moduleType !== "building") return;
    setRows((prev) =>
      (prev || []).map((row) => ({
        ...row,
        address: selectedPropertyAddress,
      }))
    );
    toast.success("Applied the selected property address to all building rows.");
  };

  // ── Import execution ──────────────────────────────────────────────────────
  const executeImport = async () => {
    if (!canImport) return;

    setImporting(true);
    const usePipelineFinalize = Boolean(pipelineFileId) && !DEFER_STORE_MODULES.has(moduleType);

    if (usePipelineFinalize) {
      try {
        if (pipelineReviewRequired) {
          const editedRows = rows.map(({ _row, ...row }) => ({
            ...row,
            ...(effectivePropertyId && !row.property_id ? { property_id: effectivePropertyId } : {}),
            ...(buildingId && !row.building_id ? { building_id: buildingId } : {}),
            ...(unitId && !row.unit_id ? { unit_id: unitId } : {}),
          }));

          const data = await invokeEdgeFunction('review-approve', {
            file_id: pipelineFileId,
            action: 'approve',
            edited_rows: editedRows,
          });
          if (data?.error) throw new Error(data.message || 'Review approval failed.');
          toast.success(`Approved and imported ${editedRows.length} ${title}.`);
        } else if (pipelineStored) {
          toast.success(`${title} already imported through the canonical pipeline.`);
        } else {
          toast.success(`${title} processed through the canonical pipeline.`);
        }

        const ENTITY_KEYS = {
          property: ['Property', 'bu-properties', 'property'],
          building: ['Building', 'bu-buildings', 'buildings'],
          unit:     ['Unit', 'bu-units', 'units'],
          lease:    ['Lease', 'leases-prop'],
          tenant:   ['Tenant'],
          vendor:   ['Vendor'],
          invoice:  ['Invoice', 'invoices'],
          revenue:  ['Revenue'],
          expense:  ['Expense', 'expenses-prop'],
          gl_account: ['GLAccount'],
          gl:       ['GLAccount'],
        };
        const keys = ENTITY_KEYS[moduleType] || [];
        if (keys.length === 0) queryClient.invalidateQueries();
        else keys.forEach(k => queryClient.invalidateQueries({ queryKey: [k] }));
        onClose();
        reset();
      } catch (err) {
        toast.error(err.message || 'Failed to finalize pipeline import.');
      } finally {
        setImporting(false);
      }
      return;
    }

    const writableOrgId = await resolveWritableOrgId(contextOrgId);
    const tenantIdCache = new Map();
    const propertyIdCache = new Map();
    const buildingIdCache = new Map();
    let importPropertyOptions = propertyOptions;
    let importBuildingOptions = buildingOptions;
    let count = 0, skipped = 0;
    const failures = [];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const normalizeLookupValue = (value) =>
      String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const ensurePropertyOptions = async () => {
      if (Array.isArray(importPropertyOptions) && importPropertyOptions.length > 0) {
        return importPropertyOptions;
      }
      const list = await PropertyService.list();
      importPropertyOptions = Array.isArray(list) ? list : [];
      return importPropertyOptions;
    };

    const ensureBuildingOptions = async () => {
      if (Array.isArray(importBuildingOptions) && importBuildingOptions.length > 0) {
        return importBuildingOptions;
      }
      const list = await BuildingService.list();
      importBuildingOptions = Array.isArray(list) ? list : [];
      return importBuildingOptions;
    };

    const resolvePropertyIdForRow = async (data) => {
      const existingId = String(data.property_id || '').trim();
      if (uuidRegex.test(existingId)) return existingId;

      const propertyCode = normalizeLookupValue(data.property_id_code || existingId);
      const propertyName = normalizeLookupValue(data.property_name);
      if (!propertyCode && !propertyName) return null;

      const cacheKey = propertyCode ? `code:${propertyCode}` : `name:${propertyName}`;
      if (propertyIdCache.has(cacheKey)) return propertyIdCache.get(cacheKey);

      const properties = await ensurePropertyOptions();
      const byCode = propertyCode
        ? properties.find((property) => normalizeLookupValue(property.property_id_code) === propertyCode)
        : null;
      const byName = propertyName
        ? properties.find((property) => normalizeLookupValue(property.name) === propertyName)
        : null;
      const byAddress = propertyName
        ? properties.find((property) => normalizeLookupValue(property.address) === propertyName)
        : null;

      const match = byCode || byName || byAddress || null;
      propertyIdCache.set(cacheKey, match?.id || null);
      return match?.id || null;
    };

    const resolveBuildingIdForRow = async (data, resolvedPropertyId) => {
      const existingId = String(data.building_id || '').trim();
      if (uuidRegex.test(existingId)) return existingId;

      const buildingCode = normalizeLookupValue(data.building_id_code || existingId);
      const buildingName = normalizeLookupValue(data.building_name);
      if (!buildingCode && !buildingName) return null;

      const cacheKey = `${resolvedPropertyId || 'any'}|${buildingCode ? `code:${buildingCode}` : `name:${buildingName}`}`;
      if (buildingIdCache.has(cacheKey)) return buildingIdCache.get(cacheKey);

      const buildings = await ensureBuildingOptions();
      const scopedBuildings = resolvedPropertyId
        ? buildings.filter((building) => building.property_id === resolvedPropertyId)
        : buildings;
      const byCode = buildingCode
        ? scopedBuildings.find((building) => normalizeLookupValue(building.building_id_code) === buildingCode)
        : null;
      const byName = buildingName
        ? scopedBuildings.find((building) => normalizeLookupValue(building.name) === buildingName)
        : null;

      const match = byCode || byName || null;
      buildingIdCache.set(cacheKey, match?.id || null);
      return match?.id || null;
    };

    for (const row of rows) {
      const { _row, ...data } = row;

      if (writableOrgId) data.org_id = writableOrgId;

      if (portfolioId) {
        const rowPortfolioId = String(data.portfolio_id || '').trim();
        if (!rowPortfolioId || !uuidRegex.test(rowPortfolioId)) {
          data.portfolio_id = portfolioId;
        }
      }

      // Attach property_id from context (page-level) OR modal selection.
      // Page context wins; modal selection is the fallback.
      if (effectivePropertyId) {
        const rowPropId = String(data.property_id || '').trim();
        if (!rowPropId || !uuidRegex.test(rowPropId)) {
          data.property_id = effectivePropertyId;
        }
      }

      // If we have a context buildingId, use it
      if (buildingId) {
        const rowBldId = String(data.building_id || '').trim();
        if (!rowBldId || !uuidRegex.test(rowBldId)) {
          data.building_id = buildingId;
        }
      }

      if (unitId) {
        const rowUnitId = String(data.unit_id || '').trim();
        if (!rowUnitId || !uuidRegex.test(rowUnitId)) {
          data.unit_id = unitId;
        }
      }

      // ── Apply Cleanup ──────────────────────────────────────────────────
      const cleanData = { ...data };
      delete cleanData.id;    // Always fresh UUID from service
      delete cleanData._row;  // UI-only index
      
      // Strip empty values to avoid DB schema constraint violations
      Object.keys(cleanData).forEach(k => {
        if (cleanData[k] === null || cleanData[k] === undefined || cleanData[k] === '') {
          delete cleanData[k];
        }
      });

      if (moduleType === 'building' && !effectivePropertyId) {
        const resolvedPropertyId = await resolvePropertyIdForRow(cleanData);
        if (resolvedPropertyId) {
          cleanData.property_id = resolvedPropertyId;
        } else {
          const propertyReference = cleanData.property_id_code || cleanData.property_name || cleanData.property_id || 'missing';
          failures.push({
            row: _row,
            message: `Could not match parent property "${propertyReference}". Select one property or use an exact Property Name / Property ID in the file.`,
          });
          skipped++;
          continue;
        }
      }

      if (moduleType === 'building') {
        delete cleanData.property_name;
        delete cleanData.property_id_code;
      }

      if (moduleType === 'unit') {
        let resolvedPropertyId = cleanData.property_id || effectivePropertyId || null;
        if (!resolvedPropertyId || !uuidRegex.test(String(resolvedPropertyId))) {
          resolvedPropertyId = await resolvePropertyIdForRow(cleanData);
        }

        let resolvedBuildingId = cleanData.building_id || buildingId || null;
        if (!resolvedBuildingId || !uuidRegex.test(String(resolvedBuildingId))) {
          resolvedBuildingId = await resolveBuildingIdForRow(cleanData, resolvedPropertyId);
        }

        if (!resolvedBuildingId && buildingId) {
          resolvedBuildingId = buildingId;
        }

        if (resolvedBuildingId && !resolvedPropertyId) {
          const buildings = await ensureBuildingOptions();
          const matchedBuilding = buildings.find((building) => building.id === resolvedBuildingId);
          resolvedPropertyId = matchedBuilding?.property_id || null;
        }

        if (!resolvedPropertyId || !uuidRegex.test(String(resolvedPropertyId))) {
          const propertyReference = cleanData.property_id_code || cleanData.property_name || cleanData.property_id || 'missing';
          failures.push({
            row: _row,
            message: `Could not match parent property "${propertyReference}". Select one property or use an exact Property Name / Property ID in the file.`,
          });
          skipped++;
          continue;
        }

        if (!resolvedBuildingId || !uuidRegex.test(String(resolvedBuildingId))) {
          const buildingReference = cleanData.building_id_code || cleanData.building_name || cleanData.building_id || 'missing';
          failures.push({
            row: _row,
            message: `Could not match parent building "${buildingReference}". Select one building or use an exact Building Name / Building ID in the file.`,
          });
          skipped++;
          continue;
        }

        cleanData.property_id = resolvedPropertyId;
        cleanData.building_id = resolvedBuildingId;
        if (cleanData.occupancy_status && !cleanData.status) {
          cleanData.status = cleanData.occupancy_status;
        }
        delete cleanData.property_name;
        delete cleanData.property_id_code;
        delete cleanData.building_name;
        delete cleanData.building_id_code;
      }

      if (moduleType === 'invoice') {
        if (cleanData.billing_period && !cleanData.issued_date) {
          cleanData.issued_date = `${cleanData.billing_period}-01`;
        }
        if (!cleanData.due_date && cleanData.issued_date) {
          cleanData.due_date = cleanData.issued_date;
        }

        const tenantName = String(cleanData.tenant_name || '').trim();
        if (!cleanData.tenant_id && tenantName) {
          if (!tenantIdCache.has(tenantName)) {
            const matches = await TenantService.filter({ name: tenantName });
            tenantIdCache.set(tenantName, matches?.[0]?.id || null);
          }
          const tenantId = tenantIdCache.get(tenantName);
          if (tenantId) cleanData.tenant_id = tenantId;
        }

        const propertyName = String(cleanData.property_name || '').trim();
        if (!cleanData.property_id && propertyName) {
          if (!propertyIdCache.has(propertyName)) {
            const matches = await PropertyService.filter({ name: propertyName });
            propertyIdCache.set(propertyName, matches?.[0]?.id || null);
          }
          const propertyIdMatch = propertyIdCache.get(propertyName);
          if (propertyIdMatch) cleanData.property_id = propertyIdMatch;
        }
      }

      if (['expense', 'revenue'].includes(moduleType)) {
        const dateVal = cleanData.date || cleanData.expense_date;
        if (dateVal && !cleanData.fiscal_year) {
          const year = new Date(dateVal).getFullYear();
          if (!isNaN(year)) cleanData.fiscal_year = year;
        }
      }

      delete cleanData.property_name;
      delete cleanData.tenant_name;

      try {
        await service.create(cleanData);
        count++;
      } catch (err) {
        console.warn(`[BulkImportModal] Row ${_row} failed:`, err?.message || err);
        failures.push({ row: _row, message: err?.message || String(err) });
        skipped++;
      }
    }

    if (skipped > 0 && count === 0) {
      // Total failure — surface the first error so the user sees the actual cause
      const first = failures[0];
      toast.error(
        `Import failed for all ${skipped} row${skipped > 1 ? 's' : ''}. ${first ? first.message : 'See console.'}`,
        { duration: 8000 }
      );
    } else if (skipped > 0) {
      toast.warning(`Imported ${count}. ${skipped} rows failed — check console for details.`);
    } else {
      toast.success(`Successfully imported ${count} ${title}!`);
    }

    // Invalidate every consumer cache for the affected entity. We invalidate both
    // the canonical entity key (used by useOrgQuery) AND the page-local keys used
    // by Properties.jsx / BuildingsUnits.jsx / PropertyDetail.jsx so the lists
    // refresh immediately after import.
    const ENTITY_KEYS = {
      property: ['Property', 'bu-properties', 'property'],
      building: ['Building', 'bu-buildings', 'buildings'],
      unit:     ['Unit', 'bu-units', 'units'],
      lease:    ['Lease', 'leases-prop'],
      tenant:   ['Tenant'],
      vendor:   ['Vendor'],
      invoice:  ['Invoice', 'invoices'],
      revenue:  ['Revenue'],
      expense:  ['Expense', 'expenses-prop'],
      gl_account: ['GLAccount'],
      gl:       ['GLAccount'],
    };
    const keys = ENTITY_KEYS[moduleType] || [];
    if (keys.length === 0) {
      queryClient.invalidateQueries();
    } else {
      keys.forEach(k => queryClient.invalidateQueries({ queryKey: [k] }));
    }
    setImporting(false);
    // Only auto-close when at least one row landed; otherwise let the user
    // see the error toast and fix the file.
    if (count > 0) {
      onClose(); reset();
    }
  };

  const isAI = ['gemini_vision', 'hybrid', 'review_required'].includes(method);

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

          {/* Target property picker — required for buildings/units when no page context */}
          {(needsPropertyPick || canUseOptionalPropertyPick) && (
            <div className="mb-4 p-3 rounded-lg border border-blue-200 bg-blue-50/60">
              <label className="block text-xs font-bold text-blue-900 mb-1.5 uppercase tracking-wide">
                Target Property {needsPropertyPick && <span className="text-red-500">*</span>}
              </label>
              <p className="text-[11px] text-blue-700/80 mb-2">
                {canUseOptionalPropertyPick
                  ? 'Optional: select one parent property for all rows. Leave blank when the file includes Parent Property or Property ID per row.'
                  : moduleType === 'building'
                    ? 'Buildings must belong to a property. Pick the parent property for these rows.'
                    : 'Units must belong to a property. Pick the parent property for these rows.'}
              </p>
              <select
                value={targetPropertyId}
                onChange={e => setTargetPropertyId(e.target.value)}
                className="w-full text-sm px-3 py-2 rounded border border-blue-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">{canUseOptionalPropertyPick ? 'Resolve from each row' : 'Select a property'}</option>
                {propertyOptions.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.address ? ` — ${p.address}` : ''}
                  </option>
                ))}
              </select>
              {propertyOptions.length === 0 && (
                <p className="text-[11px] text-amber-700 mt-1.5">
                  No properties found. Create a property first, then come back.
                </p>
              )}
            </div>
          )}

          {moduleType === "building" && effectivePropertyId && selectedPropertyAddress && rows?.length > 0 && (
            <div className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50/70">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-xs font-semibold text-amber-900">
                    Building address autofill
                  </p>
                  <p className="text-[11px] text-amber-800 mt-1">
                    Parent property address: {selectedPropertyAddress}
                  </p>
                  {hasMismatchedBuildingAddresses && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      Some building rows are blank or different. You can autofill them with the parent property address.
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={autofillBuildingAddressesFromProperty}
                  disabled={!hasMismatchedBuildingAddresses}
                >
                  Use Property Address
                </Button>
              </div>
            </div>
          )}

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
              {missingTargetProperty && allErrors.length === 0 && (
                <span className="text-[11px] text-amber-700 flex-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3"/>Pick a target property above before importing
                </span>
              )}
              {missingRowPropertyReference && allErrors.length === 0 && !missingTargetProperty && (
                <span className="text-[11px] text-amber-700 flex-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3"/>
                  {moduleType === 'unit'
                    ? `Add Parent Property, Property ID, Parent Building, Building ID, or select one target property for ${rowsMissingPropertyReference} row${rowsMissingPropertyReference !== 1 ? 's' : ''}`
                    : `Add Parent Property, Property ID, or select one target property for ${rowsMissingPropertyReference} row${rowsMissingPropertyReference !== 1 ? 's' : ''}`}
                </span>
              )}
              {missingRowBuildingReference && allErrors.length === 0 && !missingTargetProperty && !missingRowPropertyReference && (
                <span className="text-[11px] text-amber-700 flex-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3"/>
                  Add Parent Building, Building ID, or open a selected building before importing {rowsMissingBuildingReference} unit row{rowsMissingBuildingReference !== 1 ? 's' : ''}
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
