// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass, item H: a property-level report of everything a Budget
// run would depend on, so a property can be marked Budget-ready only once
// every monetary source actually reconciles and one CAM run has passed
// manual tie-out (an approved or posted cam_runs row) -- never on
// CAM-readiness alone. Read-only: this module never writes to any table.
import { detectDuplicateLeaseGroups } from "./prepare-cam-automatically.ts";

interface ReportParams {
  orgId: string;
  propertyId: string;
  recoveryPeriodId: string;
}

function overlaps(aFrom: string | null, aTo: string | null, bFrom: string, bTo: string): boolean {
  if (!aFrom) return false;
  return aFrom <= bTo && (aTo == null || aTo >= bFrom);
}

export async function buildBudgetReadinessReport(supabaseAdmin: any, params: ReportParams) {
  const { orgId, propertyId, recoveryPeriodId } = params;

  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties").select("*").eq("id", propertyId).eq("org_id", orgId).maybeSingle();
  if (propertyError) throw new Error(`Failed to load property: ${propertyError.message}`);
  if (!property) throw new Error("Property not found for this organization");

  const { data: period, error: periodError } = await supabaseAdmin
    .from("recovery_periods").select("*").eq("id", recoveryPeriodId).eq("org_id", orgId).maybeSingle();
  if (periodError) throw new Error(`Failed to load recovery period: ${periodError.message}`);
  if (!period) throw new Error("Recovery period not found for this organization");
  const periodStart: string = period.start_date;
  const periodEnd: string = period.end_date;

  // ---- Canonical active leases (approved, excluding duplicate-flagged groups) ----
  const { data: allLeases, error: leasesError } = await supabaseAdmin
    .from("leases").select("*").eq("org_id", orgId).eq("property_id", propertyId);
  if (leasesError) throw new Error(`Failed to load leases: ${leasesError.message}`);
  const approvedLeases = (allLeases || []).filter((l: any) => l.abstract_status === "approved" || l.status === "approved");
  const duplicateLeaseGroups = detectDuplicateLeaseGroups(approvedLeases);
  const duplicateLeaseIds = new Set(duplicateLeaseGroups.filter((g: any) => g.likely_duplicate).flatMap((g: any) => g.lease_ids));
  const canonicalLeases = approvedLeases.filter((l: any) => !duplicateLeaseIds.has(l.id));
  const leaseIdsForQueries = canonicalLeases.map((l: any) => l.id).length > 0 ? canonicalLeases.map((l: any) => l.id) : ["00000000-0000-0000-0000-000000000000"];

  // ---- Rent schedules ----
  const { data: rentSchedules, error: rentError } = await supabaseAdmin
    .from("rent_schedules").select("lease_id, period_start, period_end, status").in("lease_id", leaseIdsForQueries);
  if (rentError) throw new Error(`Failed to load rent schedules: ${rentError.message}`);
  const leasesWithRentCoverage = new Set(
    (rentSchedules || [])
      .filter((r: any) => r.status === "approved" && overlaps(r.period_start, r.period_end, periodStart, periodEnd))
      .map((r: any) => r.lease_id),
  );
  const leasesMissingRentSchedule = canonicalLeases.filter((l: any) => !leasesWithRentCoverage.has(l.id));

  // ---- Materialized CAM policies ----
  const { data: policies, error: policiesError } = await supabaseAdmin
    .from("lease_recovery_policies").select("id, lease_id, status").in("lease_id", leaseIdsForQueries).neq("status", "superseded");
  if (policiesError) throw new Error(`Failed to load policies: ${policiesError.message}`);
  const leasesWithApprovedPolicy = new Set((policies || []).filter((p: any) => p.status === "approved").map((p: any) => p.lease_id));
  const leasesMissingPolicy = canonicalLeases.filter((l: any) => !leasesWithApprovedPolicy.has(l.id));

  // ---- Premises / area / occupancy ----
  const { data: premises, error: premisesError } = await supabaseAdmin
    .from("lease_premises").select("lease_id, effective_from, effective_to, status, lease_premises_area_periods(effective_from, effective_to, recovery_area_sqft)")
    .in("lease_id", leaseIdsForQueries).neq("status", "superseded");
  if (premisesError) throw new Error(`Failed to load premises: ${premisesError.message}`);
  const leasesWithAreaCoverage = new Set(
    (premises || [])
      .filter((p: any) => overlaps(p.effective_from, p.effective_to, periodStart, periodEnd))
      .filter((p: any) => (p.lease_premises_area_periods || []).some((ap: any) => overlaps(ap.effective_from, ap.effective_to, periodStart, periodEnd)))
      .map((p: any) => p.lease_id),
  );
  const leasesMissingArea = canonicalLeases.filter((l: any) => !leasesWithAreaCoverage.has(l.id));

  // ---- Expense reconciliation: finalized classification total vs published cam_expense_inputs total ----
  const { data: finalizedClassifications, error: classError } = await supabaseAdmin
    .from("expense_classifications")
    .select("id, amount, recovery_status, cam_eligible, sent_to_cam, service_period_start, service_period_end")
    .eq("org_id", orgId).eq("property_id", propertyId).eq("classification_status", "finalized");
  if (classError) throw new Error(`Failed to load expense classifications: ${classError.message}`);
  const finalizedInPeriod = (finalizedClassifications || []).filter((c: any) => overlaps(c.service_period_start, c.service_period_end, periodStart, periodEnd));
  const finalizedCamEligibleTotal = finalizedInPeriod.filter((c: any) => String(c.cam_eligible).toLowerCase() === "yes").reduce((s: number, c: any) => s + Number(c.amount || 0), 0);

  const { data: publishedExpenses, error: publishedError } = await supabaseAdmin
    .from("cam_expense_inputs").select("id, amount, service_period_start, service_period_end, fiscal_year, publication_status")
    .eq("org_id", orgId).eq("property_id", propertyId).eq("publication_status", "published");
  if (publishedError) throw new Error(`Failed to load published expenses: ${publishedError.message}`);
  const periodYear = new Date(`${periodStart}T00:00:00Z`).getUTCFullYear();
  const publishedInPeriod = (publishedExpenses || []).filter((e: any) => {
    if (e.service_period_start && e.service_period_end) return overlaps(e.service_period_start, e.service_period_end, periodStart, periodEnd);
    return e.fiscal_year != null && Number(e.fiscal_year) === periodYear;
  });
  const publishedTotal = publishedInPeriod.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);

  // Data-integrity contradictions this instruction specifically named:
  // cam_eligible='yes' alongside a non_recoverable/excluded recovery_status
  // (fixed at the source going forward by migration
  // 20269900000031_fix_cam_eligible_recovery_status_contradiction.sql, but
  // still surfaced here for any row a NOT VALID constraint doesn't cover).
  const contradictoryClassifications = finalizedInPeriod.filter(
    (c: any) => String(c.cam_eligible).toLowerCase() === "yes" && ["non_recoverable", "excluded"].includes(String(c.recovery_status)),
  );

  const expenseReconciled = Math.abs(finalizedCamEligibleTotal - publishedTotal) < 0.01 && contradictoryClassifications.length === 0;

  // ---- Recovery pool readiness (defer to the existing engine rather than re-deriving it) ----
  const readinessResult = await supabaseAdmin.rpc("evaluate_cam_readiness", {
    p_org_id: orgId, p_property_id: propertyId, p_recovery_period_id: recoveryPeriodId, p_scope_type: "property", p_scope_id: propertyId,
  });
  if (readinessResult.error) throw new Error(`Readiness check failed: ${readinessResult.error.message}`);
  const readiness = readinessResult.data;
  const camReady = Boolean(readiness?.ready);

  // ---- Estimate schedule completeness ----
  const { data: estimateSchedules, error: estimateError } = await supabaseAdmin
    .from("cam_estimate_schedules").select("lease_id").eq("org_id", orgId).eq("recovery_period_id", recoveryPeriodId).in("lease_id", leaseIdsForQueries);
  if (estimateError) throw new Error(`Failed to load estimate schedules: ${estimateError.message}`);
  const leasesWithEstimate = new Set((estimateSchedules || []).map((e: any) => e.lease_id));
  const leasesMissingEstimate = canonicalLeases.filter((l: any) => !leasesWithEstimate.has(l.id));

  // ---- CAM run manual tie-out: at least one approved/posted run for this property+period ----
  const { data: camRuns, error: camRunsError } = await supabaseAdmin
    .from("cam_runs").select("id, status, approved_by, updated_at").eq("org_id", orgId).eq("recovery_period_id", recoveryPeriodId)
    .eq("scope_type", "property").eq("scope_id", propertyId).in("status", ["approved", "posted"])
    .order("updated_at", { ascending: false }).limit(1);
  if (camRunsError) throw new Error(`Failed to load CAM runs: ${camRunsError.message}`);
  const tieOutRun = (camRuns || [])[0] ?? null;

  const unresolvedInconsistencies: any[] = [
    ...duplicateLeaseGroups.map((g: any) => ({ type: "duplicate_lease_group", ...g })),
    ...contradictoryClassifications.map((c: any) => ({ type: "cam_eligible_contradiction", classification_id: c.id, amount: c.amount })),
    ...leasesMissingPolicy.map((l: any) => ({ type: "lease_missing_policy", lease_id: l.id, tenant_name: l.tenant_name })),
  ];

  const budgetReady = camReady && expenseReconciled && Boolean(tieOutRun) && unresolvedInconsistencies.length === 0;

  return {
    property_id: propertyId,
    recovery_period_id: recoveryPeriodId,
    leases: {
      canonical_count: canonicalLeases.length,
      canonical: canonicalLeases.map((l: any) => ({ id: l.id, tenant_name: l.tenant_name })),
      duplicate_groups_excluded: duplicateLeaseGroups,
    },
    rent_schedules: {
      complete_count: leasesWithRentCoverage.size,
      missing: leasesMissingRentSchedule.map((l: any) => ({ lease_id: l.id, tenant_name: l.tenant_name })),
    },
    policies: {
      materialized_approved_count: leasesWithApprovedPolicy.size,
      missing: leasesMissingPolicy.map((l: any) => ({ lease_id: l.id, tenant_name: l.tenant_name })),
    },
    premises: {
      complete_count: leasesWithAreaCoverage.size,
      missing: leasesMissingArea.map((l: any) => ({ lease_id: l.id, tenant_name: l.tenant_name })),
    },
    expenses: {
      finalized_cam_eligible_total: finalizedCamEligibleTotal,
      published_total: publishedTotal,
      discrepancy: finalizedCamEligibleTotal - publishedTotal,
      reconciled: expenseReconciled,
      contradictory_classification_count: contradictoryClassifications.length,
    },
    pools: {
      ready: camReady,
      blocking_count: readiness?.blocking_count ?? null,
      warning_count: readiness?.warning_count ?? null,
    },
    estimates: {
      complete_count: leasesWithEstimate.size,
      missing: leasesMissingEstimate.map((l: any) => ({ lease_id: l.id, tenant_name: l.tenant_name })),
    },
    unresolved_inconsistencies: unresolvedInconsistencies,
    cam_ready: camReady,
    cam_run_tie_out: tieOutRun,
    budget_ready: budgetReady,
    readiness,
  };
}
