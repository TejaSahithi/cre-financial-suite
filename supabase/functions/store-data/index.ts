// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { setStatus, setFailed, STATUS_PROGRESS } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import { triggerComputePipeline } from "../_shared/compute-orchestrator.ts";

/**
 * Store Data Edge Function
 * Inserts validated records into appropriate tables with org_id isolation
 *
 * Pipeline: Upload → Parse → Validate → **Store** → Compute → Export
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 12.1, 12.2, 12.4
 * Task: 6.1
 */

/** Maps module_type to the destination database table name */
function getTableName(moduleType: string): string {
  const tableMap: Record<string, string> = {
    leases: "leases",
    expenses: "expenses",
    properties: "properties",
    revenue: "revenues",
    buildings: "buildings",
    units: "units",
    tenants: "tenants",
    invoices: "invoices",
    gl_accounts: "gl_accounts",
  };
  const table = tableMap[moduleType];
  if (!table) {
    throw new Error(`Unsupported module_type: ${moduleType}`);
  }
  return table;
}

/**
 * Maps a single validated row to the correct table columns based on module_type.
 * Adds org_id, created_by, created_at, and updated_at to every row.
 */
function mapRow(
  row: Record<string, any>,
  moduleType: string,
  orgId: string,
  userEmail: string
): Record<string, any> {
  const now = new Date().toISOString();

  const base = {
    org_id: orgId,
    created_at: now,
    updated_at: now,
  };

  switch (moduleType) {
    case "leases":
      return {
        ...base,
        created_by: userEmail,
        tenant_name: row.tenant_name ?? null,
        start_date: row.start_date ?? row.lease_start ?? null,
        end_date: row.end_date ?? row.lease_end ?? null,
        monthly_rent: row.monthly_rent ?? row.base_rent ?? 0,
        square_footage: row.square_footage ?? row.total_sf ?? 0,
        lease_type: row.lease_type ?? null,
        status: row.status === "expired" || row.status === "budget_ready" ? row.status : "draft",
        property_id: row.property_id ?? null,
        building_id: row.building_id ?? null,
        unit_id: row.unit_id ?? null,
        annual_rent: row.annual_rent ?? null,
        rent_per_sf: row.rent_per_sf ?? null,
        lease_term_months: row.lease_term_months ?? null,
        escalation_rate: row.escalation_rate ?? row.escalation_value ?? null,
        escalation_type: row.escalation_type ?? null,
        escalation_timing: row.escalation_timing ?? null,
        cam_applicable: row.cam_applicable ?? null,
        cam_cap: row.cam_cap ?? null,
        cam_cap_type: row.cam_cap_type ?? null,
        cam_cap_rate: row.cam_cap_rate ?? null,
        admin_fee_pct: row.admin_fee_pct ?? null,
        management_fee_pct: row.management_fee_pct ?? null,
        management_fee_basis: row.management_fee_basis ?? null,
        gross_up_clause: row.gross_up_clause ?? null,
        allocation_method: row.allocation_method ?? null,
        weight_factor: row.weight_factor ?? null,
        base_year_amount: row.base_year_amount ?? null,
        expense_stop_amount: row.expense_stop_amount ?? null,
        hvac_responsibility: row.hvac_responsibility ?? null,
        notes: row.notes ?? null,
      };

    case "expenses":
      return {
        ...base,
        created_by: userEmail,
        category: row.category ?? null,
        amount: row.amount ?? 0,
        date: row.date ?? null,
        portfolio_id: row.portfolio_id ?? null,
        property_id: row.property_id ?? null,
        building_id: row.building_id ?? null,
        unit_id: row.unit_id ?? null,
        lease_id: row.lease_id ?? null,
        classification: row.classification ?? null,
        vendor: row.vendor ?? null,
        vendor_id: row.vendor_id ?? null,
        gl_code: row.gl_code ?? null,
        fiscal_year: row.fiscal_year ?? null,
        month: row.month ?? null,
        source: row.source ?? null,
        is_controllable: row.is_controllable ?? true,
        description: row.description ?? null,
        invoice_number: row.invoice_number ?? null,
        allocation_type: row.allocation_type ?? null,
        allocation_meta: row.allocation_meta ?? null,
        direct_tenant_ids: row.direct_tenant_ids ?? null,
      };

    case "properties":
      return {
        ...base,
        property_id_code: row.property_id_code ?? row.property_id ?? null,
        name: row.name ?? "Unnamed Property",
        address: row.address ?? null,
        city: row.city ?? null,
        state: row.state ?? null,
        zip: row.zip_code ?? row.zip ?? null,
        property_type: row.property_type ?? null,
        structure_type: row.structure_type ?? null,
        total_sqft: row.square_footage ?? row.total_sqft ?? row.total_sf ?? null,
        leased_sf: row.leased_sf ?? row.occupied_sf ?? null,
        total_buildings: row.total_buildings ?? row.building_count ?? null,
        total_units: row.total_units ?? row.unit_count ?? null,
        occupancy_pct: row.occupancy_pct ?? row.occupancy ?? null,
        floors: row.floors ?? null,
        year_built: row.year_built ?? null,
        status: row.status ?? "active",
        purchase_price: row.purchase_price ?? null,
        market_value: row.market_value ?? null,
        noi: row.noi ?? null,
        cap_rate: row.cap_rate ?? null,
        manager: row.manager ?? row.property_manager ?? null,
        owner: row.owner ?? row.owner_name ?? null,
        contact: row.contact ?? ([row.phone, row.email].filter(Boolean).join(" / ") || null),
        phone: row.phone ?? null,
        email: row.email ?? null,
        acquired_date: row.acquired_date ?? row.acquisition_date ?? null,
        parcel_tax_id: row.parcel_tax_id ?? row.parcel_id ?? row.tax_id ?? null,
        parking_spaces: row.parking_spaces ?? row.parking ?? null,
        amenities: row.amenities ?? null,
        insurance_policy: row.insurance_policy ?? row.insurance ?? null,
        notes: row.notes ?? null,
      };

    case "buildings":
      return {
        ...base,
        property_id: row.property_id ?? null,
        name: row.name ?? row.building_name ?? "Unnamed Building",
        address: row.address ?? null,
        total_sqft: row.total_sqft ?? row.total_sf ?? row.square_footage ?? null,
        floors: row.floors ?? null,
        year_built: row.year_built ?? null,
        status: row.status ?? "active",
      };

    case "units":
      return {
        ...base,
        property_id: row.property_id ?? null,
        building_id: row.building_id ?? null,
        unit_number: row.unit_number ?? row.suite ?? row.space ?? "Unknown",
        floor: row.floor ?? null,
        square_footage: row.square_footage ?? row.total_sf ?? row.total_sqft ?? null,
        unit_type: row.unit_type ?? row.type ?? null,
        occupancy_status: row.occupancy_status ?? row.status ?? "vacant",
        monthly_rent: row.monthly_rent ?? row.rent ?? null,
        notes: row.notes ?? null,
      };

    case "tenants":
      return {
        ...base,
        name: row.name ?? row.tenant_name ?? row.company ?? "Unnamed Tenant",
        company: row.company ?? null,
        contact_name: row.contact_name ?? row.contact ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        industry: row.industry ?? null,
        credit_rating: row.credit_rating ?? null,
        status: row.status ?? "active",
        notes: row.notes ?? null,
      };

    case "invoices":
      return {
        ...base,
        tenant_id: row.tenant_id ?? null,
        property_id: row.property_id ?? null,
        amount: row.amount ?? row.total ?? 0,
        status: row.status ?? "pending",
        due_date: row.due_date ?? null,
        issued_date: row.issued_date ?? row.date ?? null,
      };

    case "gl_accounts":
      return {
        ...base,
        code: row.code ?? row.gl_code ?? row.account_code ?? "",
        name: row.name ?? row.account_name ?? row.description ?? "",
        type: row.type ?? "expense",
        category: row.category ?? null,
        normal_balance: row.normal_balance ?? null,
        is_active: row.is_active ?? true,
        is_recoverable: row.is_recoverable ?? false,
        notes: row.notes ?? null,
      };

    case "revenue":
      return {
        ...base,
        type: row.revenue_type ?? row.type ?? "base_rent",
        amount: row.amount ?? 0,
        property_id: row.property_id ?? null,
        lease_id: row.lease_id ?? null,
        fiscal_year: row.fiscal_year ?? null,
        month: row.month ?? null,
        notes: row.notes ?? null,
      };

    default:
      throw new Error(`Unsupported module_type for row mapping: ${moduleType}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify user auth and resolve org_id
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);
    const userEmail = user.email ?? "unknown";

    // 2. Read file_id from request body
    const body = await req.json();
    const { file_id } = body;

    if (!file_id) {
      throw new Error("file_id is required");
    }

    // 3. Fetch the uploaded_files record (org_id isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      throw new Error(
        `File not found: ${fetchError?.message || "Invalid file_id or org mismatch"}`
      );
    }

    // 4. Ensure the file is cleared for storage.
    // Legacy paths arrive in 'validated'. The new review pipeline arrives in
    // 'approved' after a human clears it via review-approve. Both are valid.
    // Anything else (especially 'review_required') blocks here.
    const storableStatuses = new Set(["validated", "approved"]);
    if (!storableStatuses.has(fileRecord.status)) {
      if (fileRecord.status === "review_required") {
        throw new Error(
          `File ${file_id} is awaiting human review — cannot store until approved. ` +
          `Call review-approve to clear it.`
        );
      }
      throw new Error(
        `File status must be 'validated' or 'approved' before storing. ` +
        `Current status: ${fileRecord.status}`
      );
    }

    // Extra defense-in-depth: if review was required at any point, demand
    // that it actually ended in an approval. This prevents legacy callers
    // from sneaking around the gate by landing rows in 'validated'.
    if (
      fileRecord.review_required === true &&
      fileRecord.review_status !== "approved"
    ) {
      throw new Error(
        `File ${file_id} requires human review (review_status=${fileRecord.review_status}). ` +
        `Call review-approve to clear it before storing.`
      );
    }

    // 5. Update status to 'storing'
    await setStatus(supabaseAdmin, file_id, "storing");

    const log = createLogger(supabaseAdmin, file_id, orgId);
    await log.info("store", `Storing ${fileRecord.valid_count ?? 0} validated rows into ${fileRecord.module_type}`);

    try {
      // 6. Read valid_data from the record
      const validData: Record<string, any>[] = fileRecord.valid_data;

      if (!validData || !Array.isArray(validData) || validData.length === 0) {
        throw new Error("No valid_data found in uploaded file record");
      }

      const moduleType: string = fileRecord.module_type;
      const tableName = getTableName(moduleType);

      // Resolve the canonical property_id for this file.
      // Priority: fileRecord.property_id → first row with property_id → null
      const filePropertyId: string | null =
        fileRecord.property_id ??
        validData.find((r) => r.property_id)?.property_id ??
        null;

      // 7. Map each row to the correct table columns.
      // If a row is missing property_id but the file has one, inject it.
      const mappedRows = validData.map((row) => {
        const enriched = filePropertyId && !row.property_id
          ? { ...row, property_id: filePropertyId }
          : row;
        return mapRow(enriched, moduleType, orgId, userEmail);
      });

      // 8. Insert rows in batch
      const { data: insertedData, error: insertError } = await supabaseAdmin
        .from(tableName)
        .insert(mappedRows)
        .select("id");

      if (insertError) {
        throw new Error(
          `Failed to insert into ${tableName}: ${insertError.message}`
        );
      }

      const insertedCount = insertedData?.length ?? mappedRows.length;

      // 9. Create audit_logs entry for the batch
      await supabaseAdmin.from("audit_logs").insert({
        org_id: orgId,
        entity_type: moduleType,
        entity_id: file_id,
        action: "create",
        field_changed: null,
        old_value: null,
        new_value: JSON.stringify({ inserted_count: insertedCount, table: tableName }),
        user_email: userEmail,
        property_id: null,
        timestamp: new Date().toISOString(),
      });

      // 10. On success: update status to 'stored'
      await setStatus(supabaseAdmin, file_id, "stored", {
        processing_completed_at: new Date().toISOString(),
      });

      await log.info("store", `Stored ${insertedCount} rows into ${tableName}`, { inserted_count: insertedCount, table: tableName });

      // 11. Fire compute pipeline asynchronously (fire-and-forget).
      triggerComputePipeline({
        fileId: file_id,
        moduleType: moduleType as any,
        orgId,
        validData,
        fileRecord,
        supabaseAdmin,
        log,
      }).catch((err) => {
        console.error("[store-data] compute pipeline trigger error:", err.message);
      });

      // 12. Return success response immediately (compute runs in background)
      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: "stored",
          inserted_count: insertedCount,
          inserted_ids: (insertedData ?? []).map((row: any) => row.id).filter(Boolean),
          table: tableName,
          compute_triggered: true,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } catch (storeError) {
      await log.error("store", storeError.message);
      await setFailed(supabaseAdmin, file_id, storeError.message, "storing", STATUS_PROGRESS.storing);

      // Also log the failure in audit_logs
      await supabaseAdmin.from("audit_logs").insert({
        org_id: orgId,
        entity_type: fileRecord.module_type,
        entity_id: file_id,
        action: "store_failed",
        field_changed: null,
        old_value: null,
        new_value: storeError.message,
        user_email: userEmail,
        property_id: null,
        timestamp: new Date().toISOString(),
      });

      throw storeError;
    }
  } catch (err) {
    console.error("[store-data] Error:", err.message);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "STORAGE_FAILED",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
