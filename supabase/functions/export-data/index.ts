// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";

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
  "cam_packet",
  "budget_book",
] as const;

type ExportType = typeof VALID_EXPORT_TYPES[number];

const ENGINE_TYPE_MAP: Record<ExportType, string> = {
  rent_schedule: "lease",
  cam_calculation: "cam",
  budget: "budget",
  reconciliation: "reconciliation",
  expenses: "expense",
  revenue: "revenue",
  cam_packet: "cam",
  budget_book: "budget",
};

const EXPORT_PAGE_MAP: Record<ExportType, string[]> = {
  rent_schedule: ["Leases", "LeaseReview", "RentProjection"],
  cam_calculation: ["CAMCalculation", "CAMDashboard"],
  budget: ["BudgetDashboard", "CreateBudget", "BudgetReview"],
  reconciliation: ["Reconciliation", "ActualsVariance", "Variance"],
  expenses: ["Expenses", "AddExpense", "BulkImport"],
  revenue: ["Revenue"],
  cam_packet: ["CAMCalculation", "CAMDashboard"],
  budget_book: ["BudgetReview"],
};

const SNAPSHOT_BACKED_EXPORTS = new Set<ExportType>([
  "rent_schedule",
  "cam_calculation",
  "budget",
  "reconciliation",
  "cam_packet",
]);

const FALLBACK_TABLE_MAP: Record<ExportType, string> = {
  rent_schedule: "rent_schedules",
  cam_calculation: "cam_calculations",
  budget: "budgets",
  reconciliation: "reconciliations",
  cam_packet: "cam_calculations",
  expenses: "expenses",
  revenue: "revenues",
  budget_book: "budgets",
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
  budget_book: {
    record_type: "Record Type",
    property_name: "Property",
    fiscal_year: "Fiscal Year",
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

async function fetchBudgetRevenueDetails({
  supabaseAdmin,
  orgId,
  propertyId,
  fiscalYear,
}: {
  supabaseAdmin: any;
  orgId: string;
  propertyId: string;
  fiscalYear: number;
}) {
  const safeSelect = "property_id, lease_id, fiscal_year, month, type, amount, notes, date, tenant_name";

  let result = await supabaseAdmin
    .from("revenues")
    .select(safeSelect)
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("fiscal_year", fiscalYear)
    .order("date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (
    result.error &&
    /revenues\.(building_id|unit_id)\s+does not exist/i.test(result.error.message || "")
  ) {
    console.warn("[export-data] Retrying revenue detail export without legacy hierarchy columns");
    result = await supabaseAdmin
      .from("revenues")
      .select("lease_id, fiscal_year, month, type, amount, notes, date, tenant_name")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("fiscal_year", fiscalYear)
      .order("date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
  }

  return result;
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
    fetchBudgetRevenueDetails({
      supabaseAdmin,
      orgId,
      propertyId,
      fiscalYear,
    }),
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

async function buildCamPacketExportRows({
  supabaseAdmin,
  orgId,
  propertyId,
  fiscalYear,
  propertyName,
  camSnapshot,
  leaseId,
}: {
  supabaseAdmin: any;
  orgId: string;
  propertyId: string;
  fiscalYear: number;
  propertyName: string;
  camSnapshot: any;
  leaseId?: string | null;
}): Promise<Record<string, any>[]> {
  if (!camSnapshot?.outputs) {
    throw new Error(
      `No CAM snapshot found for property="${propertyId}" and fiscal_year=${fiscalYear}. Run compute-cam first.`,
    );
  }

  const outputs = camSnapshot.outputs as Record<string, any>;
  const inputs = (camSnapshot.inputs ?? {}) as Record<string, any>;
  const ruleEvidence: any[] = Array.isArray(inputs.rule_evidence) ? inputs.rule_evidence : [];

  let tenantCharges: any[] = Array.isArray(outputs.tenant_charges) ? outputs.tenant_charges : [];
  if (leaseId) {
    tenantCharges = tenantCharges.filter((t: any) => t.lease_id === leaseId);
  }

  // Fetch lease details for tenant enrichment
  const leaseIds = tenantCharges.map((t: any) => t.lease_id).filter(Boolean);
  let leaseMap: Record<string, any> = {};
  if (leaseIds.length > 0) {
    const { data: leases } = await supabaseAdmin
      .from("leases")
      .select("id, tenant_name, start_date, end_date, monthly_rent, annual_rent, square_footage, lease_type, status")
      .in("id", leaseIds);
    for (const l of leases ?? []) {
      leaseMap[l.id] = l;
    }
  }

  // Fetch reconciliation snapshot for expense pool breakdown (best-effort)
  const { data: reconSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "reconciliation")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const reconLineItems: any[] = Array.isArray(reconSnapshot?.outputs?.line_items)
    ? reconSnapshot.outputs.line_items
    : [];

  const rows: Record<string, any>[] = [];

  // ── Section 1: Packet header ─────────────────────────────────────────────
  rows.push({
    record_type: "cam_packet_header",
    property_name: propertyName,
    property_id: propertyId,
    fiscal_year: fiscalYear,
    snapshot_id: camSnapshot.id ?? "Not available",
    computed_at: camSnapshot.computed_at ?? "Not available",
    engine_version: camSnapshot.engine_version ?? "Not available",
    input_hash: camSnapshot.input_hash ?? "Not available",
    tenant_filter: leaseId ?? "all_tenants",
    reconciliation_snapshot_id: reconSnapshot?.id ?? "Not available",
  });

  // ── Section 2: Property-level CAM summary ────────────────────────────────
  rows.push({
    record_type: "cam_packet_property_summary",
    property_name: propertyName,
    fiscal_year: fiscalYear,
    total_cam: round2(outputs.total_cam),
    cam_per_sf: round2(outputs.cam_per_sf),
    total_recoverable: round2(outputs.total_recoverable),
    total_billed: round2(outputs.total_billed),
    direct_allocations: round2(outputs.direct_allocations),
    gross_up_adjustment: round2(outputs.gross_up_adjustment),
    admin_fees: round2(outputs.admin_fees),
    management_fees: round2(outputs.management_fees),
    total_shared_before_fees: round2(outputs.total_shared_before_fees),
    prior_payments: "Not available",
    final_adjustment: "Not available",
  });

  // ── Section 3: Per-tenant charge rows ────────────────────────────────────
  for (const tenant of tenantCharges) {
    const lease = leaseMap[tenant.lease_id] ?? {};
    rows.push({
      record_type: "cam_packet_tenant",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      tenant_name: tenant.tenant_name ?? lease.tenant_name ?? "Not available",
      lease_id: tenant.lease_id ?? "Not available",
      lease_type: lease.lease_type ?? "Not available",
      lease_start: lease.start_date ?? "Not available",
      lease_end: lease.end_date ?? "Not available",
      square_footage: round2(tenant.square_footage ?? lease.square_footage),
      pro_rata_share: tenant.pro_rata_share ?? "Not available",
      annual_cam: round2(tenant.annual_cam),
      monthly_cam: round2(tenant.monthly_cam),
      raw_share_before_caps: round2(tenant.raw_share_before_caps),
      base_year_adjustment: round2(tenant.base_year_adjustment),
      cap_adjustment: round2(tenant.cap_adjustment),
      gross_up_applied: tenant.gross_up_applied ? "Yes" : "No",
      cap_applied: tenant.cap_applied ? "Yes" : "No",
      prior_payments: "Not available",
      amount_owed_or_refund: "Not available",
    });
  }

  // ── Section 4: Expense pool breakdown (from reconciliation snapshot) ─────
  if (reconLineItems.length > 0) {
    for (const item of reconLineItems) {
      rows.push({
        record_type: "cam_packet_expense_pool",
        property_name: propertyName,
        fiscal_year: fiscalYear,
        category: item.category,
        budgeted_amount: round2(item.budget),
        actual_amount: round2(item.actual),
        variance: round2(item.variance),
        variance_pct: round2(item.variance_pct),
        flagged: item.flagged ? "Yes" : "No",
        source: "reconciliation_snapshot",
      });
    }
  } else {
    rows.push({
      record_type: "cam_packet_expense_pool",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      category: "Not available",
      budgeted_amount: "Not available",
      actual_amount: "Not available",
      variance: "Not available",
      variance_pct: "Not available",
      flagged: "Not available",
      source: "no_reconciliation_snapshot",
    });
  }

  // ── Section 5: Lease evidence citations ──────────────────────────────────
  const filteredEvidence = leaseId
    ? ruleEvidence.filter((e: any) => e.lease_id === leaseId)
    : ruleEvidence;

  if (filteredEvidence.length > 0) {
    for (const ev of filteredEvidence) {
      const tenantCharge = tenantCharges.find((t: any) => t.lease_id === ev.lease_id);
      rows.push({
        record_type: "cam_packet_evidence",
        property_name: propertyName,
        fiscal_year: fiscalYear,
        tenant_name: tenantCharge?.tenant_name ?? "Not available",
        lease_id: ev.lease_id ?? "Not available",
        rule_id: ev.rule_id ?? "Not available",
        category: ev.category ?? "Not available",
        source_page: ev.source_page ?? "Not available",
        source_text: ev.source_text ?? "Not available",
        confidence_score: ev.confidence_score ?? "Not available",
        approved_by: ev.approved_by ?? "Not available",
        approved_at: ev.approved_at ?? "Not available",
        field_review_id: ev.field_review_id ?? "Not available",
      });
    }
  } else {
    rows.push({
      record_type: "cam_packet_evidence",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      tenant_name: "Not available",
      lease_id: "Not available",
      rule_id: "Not available",
      category: "Not available",
      source_page: "Not available",
      source_text: "No lease evidence found in CAM snapshot inputs",
      confidence_score: "Not available",
      approved_by: "Not available",
      approved_at: "Not available",
      field_review_id: "Not available",
    });
  }

  // ── Section 6: Calculation assumptions ───────────────────────────────────
  const assumptions: string[] = Array.isArray(outputs.assumptions) ? outputs.assumptions : [];
  for (const assumption of assumptions) {
    rows.push({
      record_type: "cam_packet_assumption",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      assumption,
    });
  }

  return rows;
}

async function buildBudgetBookExportRows({
  supabaseAdmin,
  orgId,
  propertyId,
  fiscalYear,
  propertyName,
  budgetSnapshot,
}: {
  supabaseAdmin: any;
  orgId: string;
  propertyId: string;
  fiscalYear: number;
  propertyName: string;
  budgetSnapshot: any;
}): Promise<Record<string, any>[]> {
  if (!budgetSnapshot?.outputs) {
    throw new Error(
      `No budget snapshot found for property="${propertyId}" and fiscal_year=${fiscalYear}. Run compute-budget first.`,
    );
  }

  // Phase 1 — parallel: budget record, CAM snapshot, reconciliation snapshot, property sqft
  const [budgetRes, camRes, reconRes, propRes] = await Promise.all([
    supabaseAdmin
      .from("budgets")
      .select("id, name, status, scope, period, generation_method, total_revenue, total_expenses, cam_total, noi, ai_insights")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("budget_year", fiscalYear)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("computation_snapshots")
      .select("outputs, computed_at, engine_version, input_hash")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("computation_snapshots")
      .select("outputs, computed_at")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "reconciliation")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("properties")
      .select("name, total_sqft")
      .eq("id", propertyId)
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);

  const budget = budgetRes.data ?? null;
  const camSnapshot = camRes.data ?? null;
  const reconSnapshot = reconRes.data ?? null;
  const propertyRecord = propRes.data ?? null;

  // Phase 2 — budget_line_items requires budget.id
  let lineItems: any[] = [];
  if (budget?.id) {
    const { data: li } = await supabaseAdmin
      .from("budget_line_items")
      .select("category, subcategory, line_type, amount, source_type, notes")
      .eq("org_id", orgId)
      .eq("budget_id", budget.id)
      .order("sort_order", { ascending: true });
    lineItems = li ?? [];
  }

  const snapshotLineItems = budgetSnapshot.outputs?.line_items ?? {};
  const reconLineItems: any[] = Array.isArray(reconSnapshot?.outputs?.line_items)
    ? reconSnapshot.outputs.line_items
    : [];
  const tenantCharges: any[] = Array.isArray(camSnapshot?.outputs?.tenant_charges)
    ? camSnapshot.outputs.tenant_charges
    : [];
  const assumptions: string[] = Array.isArray(budgetSnapshot.outputs?.assumptions)
    ? budgetSnapshot.outputs.assumptions
    : [];

  const rows: Record<string, any>[] = [];

  // ── Section 1: Header (audit metadata) ───────────────────────────────────
  const readinessMeta = budgetSnapshot.inputs?.readiness_snapshot;
  rows.push({
    record_type: "budget_book_header",
    property_name: propertyName,
    fiscal_year: fiscalYear,
    budget_name: budget?.name ?? "Not available",
    budget_status: budget?.status ?? budgetSnapshot.outputs?.status ?? "Not available",
    computed_at: budgetSnapshot.computed_at ?? "Not available",
    engine_version: budgetSnapshot.engine_version ?? "Not available",
    input_hash: budgetSnapshot.input_hash ?? "Not available",
    readiness_checks: readinessMeta ? JSON.stringify(readinessMeta) : "Not available",
  });

  // ── Section 2: Property summary ───────────────────────────────────────────
  rows.push({
    record_type: "budget_book_property_summary",
    property_name: propertyName,
    fiscal_year: fiscalYear,
    total_sqft: propertyRecord?.total_sqft ?? "Not available",
    scope: budget?.scope ?? "Not available",
    period: budget?.period ?? "Not available",
    generation_method: budget?.generation_method ?? "Not available",
  });

  // ── Section 3: Financial summary ──────────────────────────────────────────
  rows.push({
    record_type: "budget_book_summary",
    property_name: propertyName,
    fiscal_year: fiscalYear,
    total_revenue: round2(budget?.total_revenue ?? snapshotLineItems?.revenue?.total),
    total_expenses: round2(budget?.total_expenses ?? snapshotLineItems?.expenses?.total),
    cam_total: round2(budget?.cam_total ?? snapshotLineItems?.revenue?.cam_recovery),
    noi: round2(budget?.noi ?? snapshotLineItems?.noi),
    ai_insights: budget?.ai_insights ?? "Not available",
  });

  // ── Section 4: Budget line items ──────────────────────────────────────────
  if (lineItems.length > 0) {
    for (const item of lineItems) {
      rows.push({
        record_type: "budget_book_line_item",
        property_name: propertyName,
        fiscal_year: fiscalYear,
        line_type: item.line_type ?? "Not available",
        category: item.category ?? "Not available",
        subcategory: item.subcategory ?? "",
        amount: round2(item.amount),
        source_type: item.source_type ?? "Not available",
        notes: item.notes ?? "",
      });
    }
  } else {
    rows.push({
      record_type: "budget_book_line_item",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      line_type: "Not available",
      category: "Not available",
      subcategory: "Not available",
      amount: "Not available",
      source_type: "Not available",
      notes: "No budget line items found",
    });
  }

  // ── Section 5: CAM summary (from latest CAM snapshot) ────────────────────
  if (camSnapshot?.outputs) {
    rows.push({
      record_type: "budget_book_cam_summary",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      total_cam: round2(camSnapshot.outputs.total_cam),
      cam_per_sf: round2(camSnapshot.outputs.cam_per_sf),
      total_recoverable: round2(camSnapshot.outputs.total_recoverable),
      total_billed: round2(camSnapshot.outputs.total_billed),
      admin_fees: round2(camSnapshot.outputs.admin_fees),
      management_fees: round2(camSnapshot.outputs.management_fees),
      tenant_count: tenantCharges.length,
      cam_computed_at: camSnapshot.computed_at ?? "Not available",
    });
  } else {
    rows.push({
      record_type: "budget_book_cam_summary",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      total_cam: "Not available",
      cam_per_sf: "Not available",
      total_recoverable: "Not available",
      total_billed: "Not available",
      admin_fees: "Not available",
      management_fees: "Not available",
      tenant_count: "Not available",
      cam_computed_at: "Not available",
    });
  }

  // ── Section 6: Reconciliation summary ────────────────────────────────────
  if (reconSnapshot?.outputs) {
    const ro = reconSnapshot.outputs as Record<string, any>;
    rows.push({
      record_type: "budget_book_recon_summary",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      cam_estimated: round2(ro.cam_estimated ?? ro.estimated_cam),
      cam_actual: round2(ro.cam_actual ?? ro.actual_cam),
      adjustment: round2(ro.adjustment ?? ro.total_adjustment),
      status: ro.status ?? "Not available",
      recon_computed_at: reconSnapshot.computed_at ?? "Not available",
    });
  } else {
    rows.push({
      record_type: "budget_book_recon_summary",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      cam_estimated: "Not available",
      cam_actual: "Not available",
      adjustment: "Not available",
      status: "Not available",
      recon_computed_at: "Not available",
    });
  }

  // ── Section 7: Variance (budget vs actual per category from recon) ────────
  if (reconLineItems.length > 0) {
    for (const item of reconLineItems) {
      rows.push({
        record_type: "budget_book_variance",
        property_name: propertyName,
        fiscal_year: fiscalYear,
        category: item.category ?? "Not available",
        budget: round2(item.budget),
        actual: round2(item.actual),
        variance: round2(item.variance),
        variance_pct: round2(item.variance_pct),
        flagged: item.flagged ? "Yes" : "No",
      });
    }
  } else {
    rows.push({
      record_type: "budget_book_variance",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      category: "Not available",
      budget: "Not available",
      actual: "Not available",
      variance: "Not available",
      variance_pct: "Not available",
      flagged: "Not available",
    });
  }

  // ── Section 8: Assumptions ────────────────────────────────────────────────
  if (assumptions.length > 0) {
    for (const assumption of assumptions) {
      rows.push({
        record_type: "budget_book_assumption",
        property_name: propertyName,
        fiscal_year: fiscalYear,
        assumption,
      });
    }
  } else {
    rows.push({
      record_type: "budget_book_assumption",
      property_name: propertyName,
      fiscal_year: fiscalYear,
      assumption: "Not available",
    });
  }

  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json();
    const { export_type, property_id, fiscal_year, format, lease_id } = body;

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

    await assertPageAccess(req, orgId, EXPORT_PAGE_MAP[export_type as ExportType] ?? [], "read");
    await assertPropertyAccess(req, property_id);

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
      .select("id, outputs, computed_at, inputs, engine_version, input_hash")
      .eq("org_id", orgId)
      .eq("property_id", property_id)
      .eq("engine_type", engineType)
      .eq("fiscal_year", fiscal_year)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let rows: Record<string, any>[] = [];

    if (export_type === "cam_packet") {
      rows = await buildCamPacketExportRows({
        supabaseAdmin,
        orgId,
        propertyId: property_id,
        fiscalYear: fiscal_year,
        propertyName,
        camSnapshot: snapshot,
        leaseId: lease_id ?? null,
      });
    } else if (export_type === "budget") {
      rows = await buildBudgetExportRows({
        supabaseAdmin,
        orgId,
        propertyId: property_id,
        fiscalYear: fiscal_year,
        propertyName,
        snapshot,
      });
    } else if (export_type === "budget_book") {
      rows = await buildBudgetBookExportRows({
        supabaseAdmin,
        orgId,
        propertyId: property_id,
        fiscalYear: fiscal_year,
        propertyName,
        budgetSnapshot: snapshot,
      });
    } else if (snapshot?.outputs) {
      rows = flattenOutputs(export_type as ExportType, snapshot.outputs);
    } else {
      if (SNAPSHOT_BACKED_EXPORTS.has(export_type as ExportType)) {
        throw new Error(
          `No completed ${engineType} snapshot found for property="${property_id}" and fiscal_year=${fiscal_year}. Run the compute engine first.`,
        );
      }

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
      `# Snapshot ID: ${escapeCSVValue(snapshot?.id ?? "")}`,
      `# Snapshot Computed At: ${escapeCSVValue(snapshot?.computed_at ?? "")}`,
      `# Engine Type: ${escapeCSVValue(engineType ?? "")}`,
      `# Engine Version: ${escapeCSVValue(snapshot?.engine_version ?? "")}`,
      `# Input Hash: ${escapeCSVValue(snapshot?.input_hash ?? "")}`,
      ...(lease_id ? [`# Tenant Lease Filter: ${escapeCSVValue(lease_id)}`] : []),
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
