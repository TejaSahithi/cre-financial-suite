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
import { resolveWritableOrgId } from "@/lib/orgUtils";
import {
  BuildingService, UnitService, RevenueService, ExpenseService,
  PropertyService, LeaseService, TenantService, GLAccountService, InvoiceService,
} from "@/services/api";

// ── Service map ──────────────────────────────────────────────────────────────
const SERVICE_MAP = {
  building: BuildingService, unit: UnitService,
  revenue: RevenueService,   expense: ExpenseService,
  property: PropertyService, lease: LeaseService,
  tenant: TenantService,     invoice: InvoiceService,
  gl_account: GLAccountService, gl: GLAccountService,
};

const MODULE_TITLES = {
  property: 'Properties', building: 'Buildings', unit: 'Units',
  lease: 'Leases', tenant: 'Tenants', revenue: 'Revenue Entries',
  expense: 'Expenses', invoice: 'Invoices',
  gl_account: 'GL Accounts', gl: 'GL Accounts',
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
    { key: 'owner',          label: 'Owner',           required: false, placeholder: 'Owner / entity' },
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

// Modules whose DB row REQUIRES a property_id (NOT NULL FK).
// When no propertyId context is provided, the user must pick one in the modal.
const REQUIRES_PROPERTY = new Set(['building', 'unit']);

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
  // Target property selected inside the modal (only used when no contextual propertyId)
  const [targetPropertyId, setTargetPropertyId] = useState('');
  const [propertyOptions, setPropertyOptions] = useState([]);
  const [selectedPropertyAddress, setSelectedPropertyAddress] = useState("");

  const title   = MODULE_TITLES[moduleType] || moduleType;
  const service = SERVICE_MAP[moduleType];
  const fieldDefs = MODULE_FIELDS[moduleType] ?? [];
  const requiredFields = fieldDefs.filter(f => f.required).map(f => f.key);

  // The property_id we'll attach to each row (context wins over modal selection)
  const effectivePropertyId = propertyId || targetPropertyId || null;
  const needsPropertyPick = REQUIRES_PROPERTY.has(moduleType) && !propertyId;

  // Load property options for the in-modal picker (only when needed)
  useEffect(() => {
    if (!isOpen || !needsPropertyPick) return;
    let cancelled = false;
    PropertyService.list().then(list => {
      if (cancelled) return;
      setPropertyOptions(Array.isArray(list) ? list : []);
    }).catch(() => { if (!cancelled) setPropertyOptions([]); });
    return () => { cancelled = true; };
  }, [isOpen, needsPropertyPick]);

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

  const reset = () => { setRows(null); setFile(null); setMethod(null); setTargetPropertyId(''); };

  // ── Merge extracted rows with full field template ─────────────────────────
  const buildRows = useCallback((extractedRows) => {
    const defaultRow = Object.fromEntries(fieldDefs.map(f => [f.key, null]));
    const allowedKeys = new Set(fieldDefs.map(f => f.key));

    // Per-module key aliases — normalize alternative names the AI / CSV may
    // produce so they map to our canonical MODULE_FIELDS key before the
    // strict filter below would otherwise drop them.
    const ALIAS_MAP = {
      property: { total_sqft: 'total_sf', square_feet: 'total_sf', sqft: 'total_sf' },
      building: { total_sqft: 'total_sf', square_feet: 'total_sf', sqft: 'total_sf' },
      unit:     { total_sf: 'square_footage', total_sqft: 'square_footage', square_feet: 'square_footage', sqft: 'square_footage' },
      lease:    { total_sf: 'square_footage', total_sqft: 'square_footage', square_feet: 'square_footage', sqft: 'square_footage', leased_sf: 'square_footage' },
      invoice:  { total_amount: 'amount', total: 'amount', amount_due: 'amount', invoice_date: 'issued_date' },
    };
    const aliases = ALIAS_MAP[moduleType] || {};

    return extractedRows.map((extracted, idx) => {
      // 1. Apply per-module aliases (without overwriting an existing canonical value)
      const aliased = {};
      Object.entries(extracted).forEach(([k, v]) => {
        const targetKey = aliases[k] || k;
        if (aliased[targetKey] === undefined || aliased[targetKey] === null) {
          aliased[targetKey] = v;
        }
      });

      // 2. STRICT FILTER: Only keep fields explicitly defined in MODULE_FIELDS for this specific module
      const filteredExtracted = Object.fromEntries(
        Object.entries(aliased).filter(([k]) => allowedKeys.has(k))
      );

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
    setTargetPropertyId('');
    setFile(f);
    setLoading(true);

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

  // Block import if this module needs a property and the user hasn't picked one yet
  const missingTargetProperty = needsPropertyPick && !effectivePropertyId;

  const canImport = rows && rows.length > 0 && allErrors.length === 0 && !importing && !missingTargetProperty;
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
    const writableOrgId = await resolveWritableOrgId(contextOrgId);
    const tenantIdCache = new Map();
    const propertyIdCache = new Map();
    let count = 0, skipped = 0;
    const failures = [];

    for (const row of rows) {
      const { _row, ...data } = row;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

          {/* Target property picker — required for buildings/units when no page context */}
          {needsPropertyPick && (
            <div className="mb-4 p-3 rounded-lg border border-blue-200 bg-blue-50/60">
              <label className="block text-xs font-bold text-blue-900 mb-1.5 uppercase tracking-wide">
                Target Property <span className="text-red-500">*</span>
              </label>
              <p className="text-[11px] text-blue-700/80 mb-2">
                {moduleType === 'building'
                  ? 'Buildings must belong to a property. Pick the parent property for these rows.'
                  : 'Units must belong to a property. Pick the parent property for these rows.'}
              </p>
              <select
                value={targetPropertyId}
                onChange={e => setTargetPropertyId(e.target.value)}
                className="w-full text-sm px-3 py-2 rounded border border-blue-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">— Select a property —</option>
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
