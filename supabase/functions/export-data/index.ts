// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Export Data Edge Function
 * Generates CSV exports from computed results and raw financial data.
 */

const VALID_EXPORT_TYPES = [
  "rent_schedule",
  "cam_calculation",
  "budget",
  "reconciliation",
  "expenses",
  "revenue",
] as const;

type ExportType = typeof VALID_EXPORT_TYPES[number];

const ENGINE_TYPE_MAP: Record<ExportType, string> = {
  rent_schedule: "lease",
  cam_calculation: "cam",
  budget: "budget",
  reconciliation: "reconciliation",
  expenses: "expense",
  revenue: "revenue",
};

const FALLBACK_TABLE_MAP: Record<ExportType, string> = {
  rent_schedule: "rent_schedules",
  cam_calculation: "cam_calculations",
  budget: "budgets",
  reconciliation: "reconciliations",
  expenses: "expenses",
  revenue: "revenues",
};

const HEADER_MAPPINGS: Record<string, Record<string, string>> = {
  rent_schedule: {
    month: "Month",
    base_rent: "Base Rent",
    escalated_rent: "Escalated Rent",
    cam_charge: "CAM Charge",
    total_rent: "Total Rent",
    tenant_name: "Tenant Name",
    lease_id: "Lease ID",
    start_date: "Start Date",
    end_date: "End Date",
    escalation_rate: "Escalation Rate",
    square_footage: "Square Footage",
  },
  cam_calculation: {
    tenant_name: "Tenant Name",
    lease_id: "Lease ID",
    square_footage: "Square Footage",
    pro_rata_share: "Pro Rata Share",
    cam_charge: "CAM Charge",
    cap_applied: "Cap Applied",
    annual_cam: "Annual CAM",
    cam_per_sf: "CAM Per SF",
    method: "Calculation Method",
    admin_fee_pct: "Admin Fee %",
    total_recoverable: "Total Recoverable",
    total_building_sf: "Total Building SF",
  },
  budget: {
    record_type: "Record Type",
    property_name: "Property",
    budget_name: "Budget Name",
    fiscal_year: "Fiscal Year",
    budget_status: "Budget Status",
    scope: "Scope",
    period: "Period",
    generation_method: "Generation Method",
    total_revenue: "Total Revenue",
    total_expenses: "Total Expenses",
    cam_total: "CAM Total",
    noi: "NOI",
    ai_insights: "AI Insights",
    category: "Category",
    line_item: "Line Item",
    amount: "Amount",
    classification: "Classification",
    vendor: "Vendor",
    month: "Month",
    date: "Date",
    description: "Description",
    invoice_number: "Invoice Number",
    is_controllable: "Is Controllable",
    tenant_name: "Tenant Name",
    lease_id: "Lease ID",
    start_date: "Lease Start",
    end_date: "Lease End",
    monthly_rent: "Monthly Rent",
    annual_rent: "Annual Rent",
    square_footage: "Square Footage",
    status: "Status",
    lease_type: "Lease Type",
    cam_amount: "CAM Amount",
    nnn_amount: "NNN Amount",
    escalation_rate: "Escalation Rate",
    pro_rata_share: "Pro Rata Share",
    cam_charge: "CAM Charge",
    annual_cam: "Annual CAM",
    cap_applied: "Cap Applied",
    total_recoverable: "Total Recoverable",
    admin_fee_pct: "Admin Fee %",
    notes: "Notes",
    source: "Source",
    portfolio_id: "Portfolio ID",
    property_id: "Property ID",
    building_id: "Building ID",
    unit_id: "Unit ID",
  },
  reconciliation: {
    tenant_name: "Tenant Name",
    lease_id: "Lease ID",
    estimated_charges: "Estimated Charges",
    actual_charges: "Actual Charges",
    adjustment: "Adjustment",
    status: "Status",
    fiscal_year: "Fiscal Year",
    reconciled_date: "Reconciled Date",
    cam_estimated: "CAM Estimated",
    cam_actual: "CAM Actual",
  },
  expenses: {
    category: "Category",
    amount: "Amount",
    description: "Description",
    vendor: "Vendor",
    date: "Date",
    classification: "Classification",
    is_controllable: "Is Controllable",
    fiscal_year: "Fiscal Year",
    invoice_number: "Invoice Number",
  },
  revenue: {
    source: "Source",
    amount: "Amount",
    tenant_name: "Tenant Name",
    category: "Category",
    date: "Date",
    fiscal_year: "Fiscal Year",
    description: "Description",
    lease_id: "Lease ID",
    type: "Type",
  },
};

function formatHeader(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeCSVValue(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function jsonToCSV(rows: Record<string, any>[], headerMap?: Record<string, string>): string {
  if (!rows || rows.length === 0) return "";

  const keySet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keySet.add(key);
    }
  }
  const keys = Array.from(keySet);

  const headerRow = keys.map((key) => escapeCSVValue(headerMap?.[key] ?? formatHeader(key)));
  const dataRows = rows.map((row) => keys.map((key) => escapeCSVValue(row[key])).join(","));

  return [headerRow.join(","), ...dataRows].join("\n");
}

function flattenOutputs(exportType: ExportType, outputs: Record<string, any>): Record<string, any>[] {
  if (Array.isArray(outputs)) {
    return outputs;
  }

  if (exportType === "cam_calculation" && Array.isArray(outputs.tenant_charges)) {
    return outputs.tenant_charges;
  }

  if (exportType === "rent_schedule" && Array.isArray(outputs.schedule)) {
    return outputs.schedule;
  }

  if (exportType === "budget" && Array.isArray(outputs.line_items)) {
    return outputs.line_items;
  }

  if (exportType === "reconciliation" && Array.isArray(outputs.tenant_reconciliations)) {
    return outputs.tenant_reconciliations;
  }

  for (const value of Object.values(outputs)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
      return value;
    }
  }

  return [outputs];
}

function toNumber(value: any): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: any): number {
  return Math.round(toNumber(value) * 100) / 100;
}

function overlapsFiscalYear(startDate: string | null, endDate: string | null, fiscalYear: number): boolean {
  const fyStart = new Date(`${fiscalYear}-01-01T00:00:00.000Z`);
  const fyEnd = new Date(`${fiscalYear}-12-31T23:59:59.999Z`);
  const leaseStart = startDate ? new Date(startDate) : fyStart;
  const leaseEnd = endDate ? new Date(endDate) : fyEnd;
  return leaseStart <= fyEnd && leaseEnd >= fyStart;
}

function createBudgetExportRow(partial: Record<string, any>): Record<string, any> {
  return {
    record_type: "",
    property_name: "",
    budget_name: "",
    fiscal_year: "",
    budget_status: "",
    scope: "",
    period: "",
    generation_method: "",
    total_revenue: "",
    total_expenses: "",
    cam_total: "",
    noi: "",
    ai_insights: "",
    category: "",
    line_item: "",
    amount: "",
    classification: "",
    vendor: "",
    month: "",
    date: "",
    description: "",
    invoice_number: "",
    is_controllable: "",
    tenant_name: "",
    lease_id: "",
    start_date: "",
    end_date: "",
    monthly_rent: "",
    annual_rent: "",
    square_footage: "",
    status: "",
    lease_type: "",
    cam_amount: "",
    nnn_amount: "",
    escalation_rate: "",
    pro_rata_share: "",
    cam_charge: "",
    annual_cam: "",
    cap_applied: "",
    total_recoverable: "",
    admin_fee_pct: "",
    notes: "",
    source: "",
    portfolio_id: "",
    property_id: "",
    building_id: "",
    unit_id: "",
    ...partial,
  };
}

async function buildBudgetExportRows({
  supabaseAdmin,
  orgId,
  propertyId,
  fiscalYear,
  propertyName,
  snapshot,
}: {
  supabaseAdmin: any;
  orgId: string;
  propertyId: string;
  fiscalYear: number;
  propertyName: string;
  snapshot: any;
}): Promise<Record<string, any>[]> {
  const [budgetRes, expensesRes, revenuesRes, leasesRes, camRes] = await Promise.all([
    supabaseAdmin
      .from("budgets")
      .select("id, name, status, scope, period, generation_method, total_revenue, total_expenses, cam_total, noi, ai_insights, portfolio_id, property_id, building_id, unit_id")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("budget_year", fiscalYear)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("expenses")
      .select("property_id, building_id, unit_id, category, amount, classification, vendor, fiscal_year, month, date, description, invoice_number, is_controllable")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("fiscal_year", fiscalYear)
      .order("date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("revenues")
      .select("property_id, building_id, unit_id, lease_id, fiscal_year, month, type, amount, notes, date, tenant_name")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("fiscal_year", fiscalYear)
      .order("date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("leases")
      .select("id, property_id, unit_id, tenant_name, start_date, end_date, monthly_rent, annual_rent, square_footage, status, lease_type, cam_amount, nnn_amount, escalation_rate, notes")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .order("start_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("computation_snapshots")
      .select("outputs, computed_at")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (budgetRes.error) throw new Error(`Failed to fetch budget export data: ${budgetRes.error.message}`);
  if (expensesRes.error) throw new Error(`Failed to fetch expense detail: ${expensesRes.error.message}`);
  if (revenuesRes.error) throw new Error(`Failed to fetch revenue detail: ${revenuesRes.error.message}`);
  if (leasesRes.error) throw new Error(`Failed to fetch lease detail: ${leasesRes.error.message}`);
  if (camRes.error) throw new Error(`Failed to fetch CAM detail: ${camRes.error.message}`);

  const budget = budgetRes.data ?? null;
  const expenses = expensesRes.data ?? [];
  const revenues = revenuesRes.data ?? [];
  const fiscalLeases = (leasesRes.data ?? []).filter((lease: any) =>
    overlapsFiscalYear(lease.start_date, lease.end_date, fiscalYear)
  );
  const camSnapshot = camRes.data ?? null;
  const lineItems = snapshot?.outputs?.line_items ?? {};

  const summaryRow = createBudgetExportRow({
    record_type: "budget_summary",
    property_name: propertyName,
    budget_name: budget?.name ?? `${propertyName} FY ${fiscalYear} Budget`,
    fiscal_year: fiscalYear,
    budget_status: budget?.status ?? snapshot?.outputs?.status ?? "draft",
    scope: budget?.scope ?? "property",
    period: budget?.period ?? "annual",
    generation_method: budget?.generation_method ?? "automated",
    total_revenue: round2(budget?.total_revenue ?? lineItems?.revenue?.total),
    total_expenses: round2(budget?.total_expenses ?? lineItems?.expenses?.total),
    cam_total: round2(budget?.cam_total ?? lineItems?.revenue?.cam_recovery ?? camSnapshot?.outputs?.total_cam),
    noi: round2(budget?.noi ?? lineItems?.noi),
    ai_insights: budget?.ai_insights ?? "",
    source: snapshot ? "budget_snapshot" : "budget_table",
    portfolio_id: budget?.portfolio_id ?? "",
    property_id: budget?.property_id ?? propertyId,
    building_id: budget?.building_id ?? "",
    unit_id: budget?.unit_id ?? "",
  });

  const rows: Record<string, any>[] = [summaryRow];

  for (const [lineItem, amount] of Object.entries(lineItems?.revenue ?? {})) {
    rows.push(
      createBudgetExportRow({
        record_type: "budget_revenue_summary",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: fiscalYear,
        line_item: lineItem,
        category: "revenue",
        amount: round2(amount),
        source: "budget_snapshot",
        property_id: propertyId,
      }),
    );
  }

  for (const [lineItem, amount] of Object.entries(lineItems?.expenses ?? {})) {
    rows.push(
      createBudgetExportRow({
        record_type: "budget_expense_summary",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: fiscalYear,
        line_item: lineItem,
        category: "expense",
        amount: round2(amount),
        source: "budget_snapshot",
        property_id: propertyId,
      }),
    );
  }

  for (const expense of expenses) {
    rows.push(
      createBudgetExportRow({
        record_type: "expense_detail",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: expense.fiscal_year ?? fiscalYear,
        category: expense.category ?? "other",
        amount: round2(expense.amount),
        classification: expense.classification ?? "",
        vendor: expense.vendor ?? "",
        month: expense.month ?? "",
        date: expense.date ?? "",
        description: expense.description ?? "",
        invoice_number: expense.invoice_number ?? "",
        is_controllable: expense.is_controllable === null || expense.is_controllable === undefined
          ? ""
          : expense.is_controllable
            ? "Yes"
            : "No",
        source: "expenses_table",
        property_id: expense.property_id ?? propertyId,
        building_id: expense.building_id ?? "",
        unit_id: expense.unit_id ?? "",
      }),
    );
  }

  for (const revenue of revenues) {
    rows.push(
      createBudgetExportRow({
        record_type: "revenue_detail",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: revenue.fiscal_year ?? fiscalYear,
        category: revenue.type ?? "other_income",
        amount: round2(revenue.amount),
        month: revenue.month ?? "",
        date: revenue.date ?? "",
        description: revenue.notes ?? "",
        tenant_name: revenue.tenant_name ?? "",
        lease_id: revenue.lease_id ?? "",
        source: "revenues_table",
        property_id: revenue.property_id ?? propertyId,
        building_id: revenue.building_id ?? "",
        unit_id: revenue.unit_id ?? "",
      }),
    );
  }

  for (const lease of fiscalLeases) {
    rows.push(
      createBudgetExportRow({
        record_type: "lease_detail",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: fiscalYear,
        tenant_name: lease.tenant_name ?? "",
        lease_id: lease.id ?? "",
        start_date: lease.start_date ?? "",
        end_date: lease.end_date ?? "",
        monthly_rent: round2(lease.monthly_rent),
        annual_rent: round2(lease.annual_rent ?? toNumber(lease.monthly_rent) * 12),
        square_footage: round2(lease.square_footage),
        status: lease.status ?? "",
        lease_type: lease.lease_type ?? "",
        cam_amount: round2(lease.cam_amount),
        nnn_amount: round2(lease.nnn_amount),
        escalation_rate: round2(lease.escalation_rate),
        notes: lease.notes ?? "",
        source: "leases_table",
        property_id: lease.property_id ?? propertyId,
        unit_id: lease.unit_id ?? "",
      }),
    );
  }

  const tenantCharges = Array.isArray(camSnapshot?.outputs?.tenant_charges)
    ? camSnapshot.outputs.tenant_charges
    : [];

  if (tenantCharges.length > 0) {
    for (const charge of tenantCharges) {
      rows.push(
        createBudgetExportRow({
          record_type: "cam_detail",
          property_name: propertyName,
          budget_name: summaryRow.budget_name,
          fiscal_year: fiscalYear,
          tenant_name: charge.tenant_name ?? "",
          lease_id: charge.lease_id ?? "",
          square_footage: round2(charge.square_footage),
          pro_rata_share: charge.pro_rata_share ?? "",
          cam_charge: round2(charge.cam_charge),
          annual_cam: round2(charge.annual_cam),
          cap_applied: charge.cap_applied ?? "",
          total_recoverable: round2(charge.total_recoverable),
          admin_fee_pct: round2(charge.admin_fee_pct),
          source: "cam_snapshot",
          property_id: propertyId,
        }),
      );
    }
  } else if (camSnapshot?.outputs?.total_cam !== undefined) {
    rows.push(
      createBudgetExportRow({
        record_type: "cam_summary",
        property_name: propertyName,
        budget_name: summaryRow.budget_name,
        fiscal_year: fiscalYear,
        cam_total: round2(camSnapshot.outputs.total_cam),
        annual_cam: round2(camSnapshot.outputs.total_cam),
        source: "cam_snapshot",
        property_id: propertyId,
      }),
    );
  }

  return rows.filter((row) =>
    Object.values(row).some((value) => value !== "" && value !== null && value !== undefined),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const body = await req.json();
    const { export_type, property_id, fiscal_year, format } = body;

    if (!export_type || !VALID_EXPORT_TYPES.includes(export_type)) {
      throw new Error(`Invalid or missing export_type. Must be one of: ${VALID_EXPORT_TYPES.join(", ")}`);
    }
    if (!property_id) {
      throw new Error("property_id is required");
    }
    if (!fiscal_year) {
      throw new Error("fiscal_year is required");
    }
    if (format && format !== "csv") {
      throw new Error('Only "csv" format is currently supported');
    }

    const { data: property } = await supabaseAdmin
      .from("properties")
      .select("id, name")
      .eq("id", property_id)
      .eq("org_id", orgId)
      .single();

    if (!property) {
      throw new Error(`Property not found or access denied: ${property_id}`);
    }

    const propertyName = property.name ?? property_id;
    const engineType = ENGINE_TYPE_MAP[export_type as ExportType];

    const { data: snapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, outputs, computed_at")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("engine_type", engineType)
      .eq("fiscal_year", fiscal_year)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let rows: Record<string, any>[] = [];

    if (export_type === "budget") {
      rows = await buildBudgetExportRows({
        supabaseAdmin,
        orgId,
        propertyId: property_id,
        fiscalYear: fiscal_year,
        propertyName,
        snapshot,
      });
    } else if (snapshot?.outputs) {
      rows = flattenOutputs(export_type as ExportType, snapshot.outputs);
    } else {
      const fallbackTable = FALLBACK_TABLE_MAP[export_type as ExportType];

      const yearColumn = export_type === "budget" ? "budget_year" : "fiscal_year";
      const { data: rawData, error: rawErr } = await supabaseAdmin
        .from(fallbackTable)
        .select("*")
        .eq("org_id", orgId)
        .eq("property_id", property_id)
        .eq(yearColumn, fiscal_year)
        .order("created_at", { ascending: true });

      if (rawErr) {
        console.error(`[export-data] Initial query failed for ${fallbackTable}:`, rawErr.message);
        const { data: retryData, error: retryErr } = await supabaseAdmin
          .from(fallbackTable)
          .select("*")
          .eq("org_id", orgId)
          .eq("property_id", property_id)
          .order("created_at", { ascending: true });

        if (retryErr) {
          throw new Error(`Failed to fetch data from ${fallbackTable}: ${retryErr.message}`);
        }
        rows = retryData ?? [];
      } else {
        rows = rawData ?? [];
      }

      const INTERNAL_COLUMNS = ["id", "org_id", "created_at", "updated_at"];
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
        `No data found for export_type="${export_type}" (Engine: ${engineType}, Table: ${FALLBACK_TABLE_MAP[export_type as ExportType]}). Parameters: property="${property_id}", fiscal_year=${fiscal_year}, org_id="${orgId}". Rows found: 0.`,
      );
    }

    const headerMap = HEADER_MAPPINGS[export_type] ?? {};
    const dataCsv = jsonToCSV(rows, headerMap);
    const exportDate = new Date().toISOString();

    const metadataRows = [
      `# Export Date: ${exportDate}`,
      `# Property: ${escapeCSVValue(propertyName)}`,
      `# Fiscal Year: ${fiscal_year}`,
      `# Export Type: ${formatHeader(export_type)}`,
      `# Rows: ${rows.length}`,
      "",
    ];

    const fullCsv = metadataRows.join("\n") + dataCsv + "\n";

    const exportId = crypto.randomUUID();
    const storagePath = `exports/${orgId}/${exportId}.csv`;
    const csvBlob = new Blob([fullCsv], { type: "text/csv; charset=utf-8" });

    const { error: uploadErr } = await supabaseAdmin.storage
      .from("financial-uploads")
      .upload(storagePath, csvBlob, {
        contentType: "text/csv",
        upsert: false,
      });

    if (uploadErr) {
      console.error("[export-data] Storage upload error:", uploadErr.message);
    }

    let downloadUrl = null;
    if (!uploadErr) {
      const { data: signedData, error: signErr } = await supabaseAdmin.storage
        .from("financial-uploads")
        .createSignedUrl(storagePath, 3600);

      if (!signErr && signedData?.signedUrl) {
        downloadUrl = signedData.signedUrl;
      } else {
        console.error("[export-data] Signed URL error:", signErr?.message);
      }
    }

    return new Response(
      JSON.stringify({
        error: false,
        export_id: exportId,
        download_url: downloadUrl,
        format: "csv",
        row_count: rows.length,
        export_type,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[export-data] Error:", err.message);
    
    // For 'No data found' errors, return a 200 with error: true so 
    // the frontend can gracefully show a toast instead of a 400 crash
    if (err.message?.includes("No data found")) {
      return new Response(
        JSON.stringify({ error: true, message: err.message, empty: true }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
