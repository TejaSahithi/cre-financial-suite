// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Export Data Edge Function
 * Generates CSV from computed results with human-readable headers and metadata.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 * Task: 18.1
 */

// ============================================================
// Valid export types — must match computation_snapshots.engine_type
// ============================================================

const VALID_EXPORT_TYPES = [
  'rent_schedule',
  'cam_calculation',
  'budget',
  'reconciliation',
  'expenses',
  'revenue',
] as const;

type ExportType = typeof VALID_EXPORT_TYPES[number];

// Map export_type to the engine_type stored in computation_snapshots
const ENGINE_TYPE_MAP: Record<ExportType, string> = {
  rent_schedule: 'lease',
  cam_calculation: 'cam',
  budget: 'budget',
  reconciliation: 'reconciliation',
  expenses: 'expense',
  revenue: 'revenue',
};

// Map export_type to fallback raw-data table when no snapshot exists
const FALLBACK_TABLE_MAP: Record<ExportType, string> = {
  rent_schedule: 'rent_schedules',
  cam_calculation: 'cam_calculations',
  budget: 'budgets',
  reconciliation: 'reconciliations',
  expenses: 'expenses',
  revenue: 'revenue',
};

// ============================================================
// Human-readable column header mappings per export type
// ============================================================

const HEADER_MAPPINGS: Record<string, Record<string, string>> = {
  rent_schedule: {
    month: 'Month',
    base_rent: 'Base Rent',
    escalated_rent: 'Escalated Rent',
    cam_charge: 'CAM Charge',
    total_rent: 'Total Rent',
    tenant_name: 'Tenant Name',
    lease_id: 'Lease ID',
    start_date: 'Start Date',
    end_date: 'End Date',
    escalation_rate: 'Escalation Rate',
    square_footage: 'Square Footage',
  },
  cam_calculation: {
    tenant_name: 'Tenant Name',
    lease_id: 'Lease ID',
    square_footage: 'Square Footage',
    pro_rata_share: 'Pro Rata Share',
    cam_charge: 'CAM Charge',
    cap_applied: 'Cap Applied',
    annual_cam: 'Annual CAM',
    cam_per_sf: 'CAM Per SF',
    method: 'Calculation Method',
    admin_fee_pct: 'Admin Fee %',
    total_recoverable: 'Total Recoverable',
    total_building_sf: 'Total Building SF',
  },
  budget: {
    category: 'Category',
    budgeted_amount: 'Budgeted Amount',
    actual_amount: 'Actual Amount',
    variance: 'Variance',
    variance_pct: 'Variance %',
    fiscal_year: 'Fiscal Year',
    notes: 'Notes',
    line_item: 'Line Item',
    department: 'Department',
  },
  reconciliation: {
    tenant_name: 'Tenant Name',
    lease_id: 'Lease ID',
    estimated_charges: 'Estimated Charges',
    actual_charges: 'Actual Charges',
    adjustment: 'Adjustment',
    status: 'Status',
    fiscal_year: 'Fiscal Year',
    reconciled_date: 'Reconciled Date',
    cam_estimated: 'CAM Estimated',
    cam_actual: 'CAM Actual',
  },
  expenses: {
    category: 'Category',
    amount: 'Amount',
    description: 'Description',
    vendor: 'Vendor',
    date: 'Date',
    classification: 'Classification',
    is_controllable: 'Is Controllable',
    fiscal_year: 'Fiscal Year',
    invoice_number: 'Invoice Number',
  },
  revenue: {
    source: 'Source',
    amount: 'Amount',
    tenant_name: 'Tenant Name',
    category: 'Category',
    date: 'Date',
    fiscal_year: 'Fiscal Year',
    description: 'Description',
    lease_id: 'Lease ID',
    type: 'Type',
  },
};

// ============================================================
// CSV Pretty Printer helpers
// ============================================================

/**
 * Converts a snake_case key to Title Case for display.
 * Used as fallback when no explicit header mapping exists.
 */
function formatHeader(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Escapes a value for safe inclusion in a CSV cell.
 * Handles commas, double-quotes, and newlines per RFC 4180.
 */
function escapeCSVValue(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Converts an array of JSON objects to a CSV string.
 *
 * @param rows       - Array of flat key-value objects
 * @param headerMap  - Optional mapping from key -> human-readable label
 * @returns CSV string with header row + data rows
 */
function jsonToCSV(rows: Record<string, any>[], headerMap?: Record<string, string>): string {
  if (!rows || rows.length === 0) return '';

  // Collect every unique key across all rows (preserves insertion order)
  const keySet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keySet.add(key);
    }
  }
  const keys = Array.from(keySet);

  // Build header row using mapping or fallback formatter
  const headerRow = keys.map((k) => {
    const label = headerMap?.[k] ?? formatHeader(k);
    return escapeCSVValue(label);
  });

  // Build data rows
  const dataRows = rows.map((row) =>
    keys.map((k) => escapeCSVValue(row[k])).join(',')
  );

  return [headerRow.join(','), ...dataRows].join('\n');
}

// ============================================================
// Helper: flatten nested snapshot outputs into flat rows
// ============================================================

function flattenOutputs(exportType: ExportType, outputs: Record<string, any>): Record<string, any>[] {
  // computation_snapshots.outputs may contain nested arrays (e.g. tenant_charges)
  // or be a single summary object. We normalise to an array of flat rows.

  if (Array.isArray(outputs)) {
    return outputs;
  }

  // For CAM snapshots, the per-tenant detail lives in tenant_charges
  if (exportType === 'cam_calculation' && Array.isArray(outputs.tenant_charges)) {
    return outputs.tenant_charges;
  }

  // For rent_schedule snapshots, check for a schedule array
  if (exportType === 'rent_schedule' && Array.isArray(outputs.schedule)) {
    return outputs.schedule;
  }

  // For budget snapshots, check for line_items
  if (exportType === 'budget' && Array.isArray(outputs.line_items)) {
    return outputs.line_items;
  }

  // For reconciliation snapshots, check for tenant_reconciliations
  if (exportType === 'reconciliation' && Array.isArray(outputs.tenant_reconciliations)) {
    return outputs.tenant_reconciliations;
  }

  // Generic: look for the first array value in the outputs object
  for (const value of Object.values(outputs)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      return value;
    }
  }

  // Last resort: wrap the outputs object itself as a single-row export
  return [outputs];
}

// ============================================================
// Main handler
// ============================================================

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ----------------------------------------------------------
    // 1. Auth & org resolution
    // ----------------------------------------------------------
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // ----------------------------------------------------------
    // 2. Parse & validate request body
    // ----------------------------------------------------------
    const body = await req.json();
    const { export_type, property_id, fiscal_year, format } = body;

    if (!export_type || !VALID_EXPORT_TYPES.includes(export_type)) {
      throw new Error(
        `Invalid or missing export_type. Must be one of: ${VALID_EXPORT_TYPES.join(', ')}`,
      );
    }
    if (!property_id) {
      throw new Error('property_id is required');
    }
    if (!fiscal_year) {
      throw new Error('fiscal_year is required');
    }
    if (format && format !== 'csv') {
      throw new Error('Only "csv" format is currently supported');
    }

    // ----------------------------------------------------------
    // 3. Fetch property name for metadata header
    // ----------------------------------------------------------
    const { data: property } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .eq('id', property_id)
      .eq('org_id', orgId)
      .single();

    if (!property) {
      throw new Error(`Property not found or access denied: ${property_id}`);
    }

    const propertyName = property.name ?? property_id;

    // ----------------------------------------------------------
    // 4. Try to fetch data from computation_snapshots first
    // ----------------------------------------------------------
    const engineType = ENGINE_TYPE_MAP[export_type as ExportType];

    const { data: snapshot } = await supabaseAdmin
      .from('computation_snapshots')
      .select('id, outputs, computed_at')
      .eq('org_id', orgId)
      .eq('property_id', property_id)
      .eq('engine_type', engineType)
      .eq('fiscal_year', fiscal_year)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let rows: Record<string, any>[] = [];

    if (snapshot && snapshot.outputs) {
      // Use the most recent snapshot outputs
      rows = flattenOutputs(export_type as ExportType, snapshot.outputs);
    } else {
      // ----------------------------------------------------------
      // 5. Fallback: fetch raw data from the relevant table
      // ----------------------------------------------------------
      const fallbackTable = FALLBACK_TABLE_MAP[export_type as ExportType];

      let query = supabaseAdmin
        .from(fallbackTable)
        .select('*')
        .eq('org_id', orgId)
        .eq('property_id', property_id);

      // Handle the different year column names across tables
      const yearColumn = (export_type === 'budget') ? 'budget_year' : 'fiscal_year';
      
      const { data: rawData, error: rawErr } = await query
        .eq(yearColumn, fiscal_year)
        .order('created_at', { ascending: true });

      if (rawErr) {
        console.error(`[export-data] Initial query failed for ${fallbackTable}:`, rawErr.message);
        // Retry without year filter as a last resort
        const { data: retryData, error: retryErr } = await supabaseAdmin
          .from(fallbackTable)
          .select('*')
          .eq('org_id', orgId)
          .eq('property_id', property_id)
          .order('created_at', { ascending: true });

        if (retryErr) {
          throw new Error(`Failed to fetch data from ${fallbackTable}: ${retryErr.message}`);
        }
        rows = retryData ?? [];
      } else {
        rows = rawData ?? [];
      }

      // Strip internal/system columns that should not appear in exports
      const INTERNAL_COLUMNS = ['id', 'org_id', 'created_at', 'updated_at'];
      rows = rows.map((row: Record<string, any>) => {
        const cleaned: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!INTERNAL_COLUMNS.includes(key)) {
            cleaned[key] = value;
          }
        }
        return cleaned;
      });
    }

    if (rows.length === 0) {
      throw new Error(
        `No data found for export_type="${export_type}", property="${property_id}", fiscal_year=${fiscal_year}`,
      );
    }

    // ----------------------------------------------------------
    // 6. Build CSV with metadata header rows
    // ----------------------------------------------------------
    const headerMap = HEADER_MAPPINGS[export_type] ?? {};
    const dataCsv = jsonToCSV(rows, headerMap);
    const exportDate = new Date().toISOString();

    const metadataRows = [
      `# Export Date: ${exportDate}`,
      `# Property: ${escapeCSVValue(propertyName)}`,
      `# Fiscal Year: ${fiscal_year}`,
      `# Export Type: ${formatHeader(export_type)}`,
      `# Rows: ${rows.length}`,
      '', // blank line separates metadata from data
    ];

    const fullCsv = metadataRows.join('\n') + dataCsv + '\n';

    // ----------------------------------------------------------
    // 7. Store CSV in Supabase Storage
    // ----------------------------------------------------------
    const exportId = crypto.randomUUID();
    const storagePath = `exports/${orgId}/${exportId}.csv`;

    const csvBlob = new Blob([fullCsv], { type: 'text/csv; charset=utf-8' });

    const { error: uploadErr } = await supabaseAdmin.storage
      .from('financial-uploads')
      .upload(storagePath, csvBlob, {
        contentType: 'text/csv',
        upsert: false,
      });

    if (uploadErr) {
      console.error('[export-data] Storage upload error:', uploadErr.message);
      // Non-fatal: we still return the CSV inline if storage fails
    }

    // Generate a signed download URL (valid for 1 hour)
    let downloadUrl = null;
    if (!uploadErr) {
      const { data: signedData, error: signErr } = await supabaseAdmin.storage
        .from('financial-uploads')
        .createSignedUrl(storagePath, 3600); // 1 hour

      if (!signErr && signedData?.signedUrl) {
        downloadUrl = signedData.signedUrl;
      } else {
        console.error('[export-data] Signed URL error:', signErr?.message);
      }
    }

    // ----------------------------------------------------------
    // 8. Return response
    // ----------------------------------------------------------
    return new Response(
      JSON.stringify({
        error: false,
        export_id: exportId,
        download_url: downloadUrl,
        format: 'csv',
        row_count: rows.length,
        export_type,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    console.error('[export-data] Error:', err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
