// @ts-nocheck
// Phase 5A — Approved Annual Budget Workbook payload assembly (server side).
// Consumed by src/services/approvedBudgetWorkbookGenerator.js, which turns
// this JSON into the 9-sheet .xlsx client-side. This module owns exactly
// one responsibility: read the LOCKED budget's own frozen source-snapshot
// lineage and return each snapshot BY THAT EXACT ID — never "the latest
// completed snapshot for this property/year", which could be a snapshot
// computed AFTER approval and therefore not what the approver actually
// signed off on. A draft (not-yet-locked) budget's export is expected to
// use a live/uncertain lineage (there is no frozen snapshot to point to
// yet), so falls back to matching by scope+fiscal_year for that
// not-yet-locked case only.
//
// Lineage is recorded on the DRAFT-GENERATION `computation_snapshots` row
// (engine_type='budget', written by compute-budget's handleGeneratePlanning),
// in inputs._compute.source_snapshot_ids — NOT on the separate "baseline"
// row approve_and_lock_budget's own RPC inserts at approval time (that row
// carries approval metadata only, no source_snapshot_ids, and is written
// with scope_level/scope_id left NULL, which is exactly how it is
// distinguished here from the real lineage row).

function round2(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export interface BuildApprovedBudgetWorkbookParams {
  supabaseAdmin: any;
  orgId: string;
  propertyId: string;
  fiscalYear: number;
  propertyName: string;
  budget: Record<string, any>;
}

export async function buildApprovedBudgetWorkbookPayload({
  supabaseAdmin,
  orgId,
  propertyId,
  fiscalYear,
  propertyName,
  budget,
}: BuildApprovedBudgetWorkbookParams) {
  if (!budget?.id) {
    throw new Error("A resolved budget is required to build the approved budget workbook payload");
  }

  // ---------------------------------------------------------------
  // 1. Find the draft-generation 'budget' snapshot that carries this
  // budget's OWN frozen source_snapshot_ids lineage -- scoped to this
  // exact budget's scope_level/scope_id/fiscal_year, which is what
  // separates it from the scope-less approval "baseline" row.
  // ---------------------------------------------------------------
  const { data: lineageSnapshot, error: lineageErr } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, inputs, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "budget")
    .eq("scope_level", budget.scope)
    .eq("scope_id", budget.scope_id)
    .eq("fiscal_year", fiscalYear)
    .eq("status", "completed")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lineageErr) throw new Error(`Failed to load budget lineage snapshot: ${lineageErr.message}`);

  const sourceSnapshotIds: Record<string, string | null> =
    lineageSnapshot?.inputs?._compute?.source_snapshot_ids ?? {};
  const basisSnapshotId = sourceSnapshotIds.budget_basis ?? null;
  const camSnapshotId = sourceSnapshotIds.budget_cam_estimate ?? null;
  const revenueSnapshotId = sourceSnapshotIds.revenue ?? null;

  const isLocked = budget.status === "locked";
  if (isLocked && (!basisSnapshotId || !camSnapshotId || !revenueSnapshotId)) {
    throw new Error(
      `Locked budget ${budget.id} has no complete frozen source_snapshot_ids lineage recorded (found: ${JSON.stringify(sourceSnapshotIds)}). ` +
      `This budget was not generated through the Phase 3A/3B/Revenue planning pipeline and cannot be exported as an approved workbook.`,
    );
  }

  // ---------------------------------------------------------------
  // 2. Load each referenced snapshot BY ITS EXACT ID (not "latest") --
  // the whole point of this rewrite. Still org/property/engine_type
  // scoped so a stale or cross-tenant id can never leak another
  // organization's data even if the lineage JSON were somehow tampered
  // with upstream.
  // ---------------------------------------------------------------
  async function loadSnapshotById(id: string | null, engineType: string) {
    if (!id) return null;
    const { data, error } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, outputs, computed_at, engine_version, input_hash")
      .eq("id", id)
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", engineType)
      .maybeSingle();
    if (error) throw new Error(`Failed to load ${engineType} snapshot ${id}: ${error.message}`);
    return data;
  }

  const [basisSnapshot, camSnapshot, revenueSnapshot, lineItemsRes, propertyRes, approverRes, reviewerRes] = await Promise.all([
    loadSnapshotById(basisSnapshotId, "budget_basis"),
    loadSnapshotById(camSnapshotId, "budget_cam_estimate"),
    loadSnapshotById(revenueSnapshotId, "revenue"),
    supabaseAdmin
      .from("budget_line_items")
      .select("category, subcategory, line_type, amount, source_type, source_snapshot_id, notes")
      .eq("org_id", orgId)
      .eq("budget_id", budget.id)
      .order("sort_order", { ascending: true }),
    supabaseAdmin.from("properties").select("name, total_sqft").eq("id", propertyId).eq("org_id", orgId).maybeSingle(),
    budget.approved_by
      ? supabaseAdmin.from("profiles").select("full_name, email").eq("id", budget.approved_by).maybeSingle()
      : Promise.resolve({ data: null }),
    budget.reviewed_by
      ? supabaseAdmin.from("profiles").select("full_name, email").eq("id", budget.reviewed_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const lineItems = lineItemsRes.data ?? [];
  const propertyRecord = propertyRes.data ?? null;
  const approverProfile = approverRes.data ?? null;
  const reviewerProfile = reviewerRes.data ?? null;

  // ---------------------------------------------------------------
  // 3. Reshape Phase 3B's tenant_detail into the tenant_recoveries shape
  // Sheet 5 (Tenant CAM Estimates) already expects -- same computed
  // figures (annual_estimated_cam, recovery_method, share_explanation),
  // just renamed, not recomputed.
  // ---------------------------------------------------------------
  const tenantDetail = Array.isArray(camSnapshot?.outputs?.tenant_detail) ? camSnapshot.outputs.tenant_detail : [];
  const tenantRecoveries = tenantDetail.map((t: any) => ({
    tenant_name: t.tenant_name,
    lease_id: t.lease_id,
    square_footage: t.premises_area_sqft,
    estimated_annual_recovery: t.annual_estimated_cam,
    calculation_method: t.recovery_method,
    notes: t.share_explanation,
  }));

  return {
    budget: {
      id: budget.id,
      property_id: propertyId,
      fiscal_year: fiscalYear,
      status: budget.status,
      is_locked: isLocked,
      scope: budget.scope,
      generation_method: budget.generation_method,
      total_revenue: round2(budget.total_revenue),
      total_expenses: round2(budget.total_expenses),
      cam_total: round2(budget.cam_total),
      noi: round2(budget.noi),
      ai_insights: budget.ai_insights ?? null,
      reviewer_name: reviewerProfile?.full_name || reviewerProfile?.email || null,
      reviewed_at: budget.reviewed_at ?? null,
      approver_name: approverProfile?.full_name || approverProfile?.email || null,
      approver_role: budget.approved_by_role ?? null,
      approved_at: budget.approved_at ?? null,
      approval_comment: budget.approval_comment ?? null,
      locked_at: budget.locked_at ?? null,
      version_hash: budget.version_hash ?? null,
    },
    property: {
      name: propertyRecord?.name ?? propertyName,
      total_sqft: propertyRecord?.total_sqft ?? null,
    },
    line_items: lineItems,
    expense_basis: basisSnapshot?.outputs ?? {},
    cam_estimate: {
      ...(camSnapshot?.outputs ?? {}),
      tenant_recoveries: tenantRecoveries,
    },
    revenue_baseline: revenueSnapshot?.outputs ?? {},
    source_snapshot_ids: {
      budget_basis: basisSnapshotId,
      budget_cam_estimate: camSnapshotId,
      revenue: revenueSnapshotId,
    },
    source_snapshot_meta: {
      budget_basis: basisSnapshot ? { computed_at: basisSnapshot.computed_at, engine_version: basisSnapshot.engine_version, input_hash: basisSnapshot.input_hash } : null,
      budget_cam_estimate: camSnapshot ? { computed_at: camSnapshot.computed_at, engine_version: camSnapshot.engine_version, input_hash: camSnapshot.input_hash } : null,
      revenue: revenueSnapshot ? { computed_at: revenueSnapshot.computed_at, engine_version: revenueSnapshot.engine_version, input_hash: revenueSnapshot.input_hash } : null,
    },
  };
}
