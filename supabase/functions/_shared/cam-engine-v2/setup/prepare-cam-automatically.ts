// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass: "Prepare CAM Automatically".
//
// Root cause this exists to address (confirmed against real production
// data before writing a line of this file): the entire CAM Engine V2
// materialization/backfill pipeline had NEVER been invoked against real
// leases. Production had 28 approved lease_expense_rules and 9 leases, but
// ZERO lease_recovery_policies and ZERO lease_premises anywhere in the
// database -- materialize_lease_recovery_policy and
// backfill_cam_engine_v2_legacy_data are fully built, tested RPCs (see
// their own migrations) that nothing in the live product ever called.
//
// This module does NOT implement a second calculation engine, NOT add new
// source tables, and NOT invent any contractual value. It orchestrates
// EXISTING, already-tested primitives (the legacy backfill RPC, the policy
// materializer RPC, evaluate_cam_readiness) against a specific
// property+recovery_period, and computes READ-ONLY suggestions (pools,
// participants, expense assignments) the same way the CAM Setup wizard's
// own suggestion helpers do -- nothing here is persisted except the two
// backfill/materialization writes, both idempotent and both already
// tagged for human review by their own underlying RPCs.
//
// Idempotency: rerunning this for the same property+period is safe --
// backfill and materialize are both NOT-EXISTS/hash-based idempotent, and
// every suggestion computed here is freshly derived from current data on
// every call, never accumulated or duplicated.

interface PrepareParams {
  orgId: string;
  propertyId: string;
  recoveryPeriodId: string;
  actorUserId: string;
  actorEmail: string;
}

function normalizeTenantName(name: string | null): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Item C: duplicate-lease detection. Groups leases by (normalized tenant
 * name, building_id) within the property. A group of 2+ leases sharing the
 * SAME building AND the SAME exact square footage, with no distinguishing
 * premises data, is flagged as a likely duplicate (the pattern confirmed
 * in the real "Hudson & Pine" case this was built against: 3 lease rows,
 * same tenant/building/5,800 sqft, but conflicting dates/rent/lease_type
 * -- consistent with the same source document being extracted three
 * times, not three legitimate premises). A group sharing tenant+building
 * but with DIFFERENT square footage per record is reported as a possible
 * legitimate multi-premises situation instead, for a human to confirm --
 * this function never merges or deletes anything itself.
 */
export function detectDuplicateLeaseGroups(leases: any[]) {
  const groups = new Map<string, any[]>();
  for (const lease of leases) {
    const key = `${normalizeTenantName(lease.tenant_name)}|${lease.building_id || "none"}`;
    if (!key.startsWith("|") === false && normalizeTenantName(lease.tenant_name) === "") continue; // no tenant name to group on
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(lease);
  }
  const result: any[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sqftValues = new Set(group.map((l) => l.square_footage ?? null));
    const allSameSqft = sqftValues.size === 1;
    result.push({
      tenant_name: group[0].tenant_name,
      building_id: group[0].building_id,
      lease_ids: group.map((l) => l.id),
      lease_count: group.length,
      likely_duplicate: allSameSqft,
      reason: allSameSqft
        ? `${group.length} lease records share the same tenant, building, and exact square footage (${group[0].square_footage ?? "unknown"} sqft) with no distinguishing premises -- consistent with the same lease being extracted more than once, not legitimate separate premises. Consolidate to one canonical lease record before this tenant participates in any pool.`
        : `${group.length} lease records share the same tenant and building but report different square footage -- may be legitimate multiple premises for the same tenant. Verify against the source lease document before treating as duplicates.`,
    });
  }
  return result;
}

async function callRpc(supabaseAdmin: any, fn: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  return { data, error };
}

// Real gap found investigating why A1/FY2026 showed zero finalized
// CAM-eligible expenses despite materialized policies existing:
// lease_expense_rules.published_to_cam gates expenseService.js's
// isAutomaticCamReady (and send_expense_classification_to_cam_workflow's
// own publish check) independently of approval_status -- a rule can be
// approved and even materialized into a policy while published_to_cam
// stays false forever, because nothing in the live product ever called
// publish_lease_expense_rule_to_cam_workflow either (the same class of gap
// as materialize_lease_recovery_policy before this module existed).
// deriveServerCamPublishBlockers is the existing, already-deployed,
// deterministic gate (publish-lease-expense-rule-to-cam edge function) --
// reused here verbatim rather than re-derived, so this step can never
// publish a rule the manual UI action would have refused.
import { deriveServerCamPublishBlockers } from "../../lease-expense-rule-cam-publish-workflow.ts";

async function publishEligibleRulesToCam(
  supabaseAdmin: any,
  approvedRules: any[],
  duplicateLeaseIds: Set<string>,
  orgId: string,
  actorUserId: string,
  actorEmail: string,
) {
  let published = 0;
  let alreadyPublished = 0;
  const notPublishable: any[] = [];

  for (const rule of approvedRules) {
    if (rule.published_to_cam === true) {
      alreadyPublished += 1;
      continue;
    }
    if (duplicateLeaseIds.has(rule.lease_id)) {
      notPublishable.push({ rule_id: rule.id, lease_id: rule.lease_id, blockers: ["duplicate_lease_pending_review"] });
      continue;
    }
    const blockers = deriveServerCamPublishBlockers(rule);
    if (blockers.length > 0 && !(blockers.length === 1 && blockers[0] === "already_published")) {
      notPublishable.push({ rule_id: rule.id, lease_id: rule.lease_id, blockers });
      continue;
    }
    const { data, error } = await supabaseAdmin.rpc("publish_lease_expense_rule_to_cam_workflow", {
      p_org_id: orgId,
      p_rule_id: rule.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_idempotency_key: `prepare-cam-automatically:${rule.id}`,
      p_request_payload: { source: "prepare_cam_automatically" },
    });
    if (error) {
      notPublishable.push({ rule_id: rule.id, lease_id: rule.lease_id, blockers: [error.message] });
      continue;
    }
    if (data?.already_published) alreadyPublished += 1;
    else published += 1;
  }

  return { published, alreadyPublished, notPublishable };
}

function leaseOverlapsPeriod(lease: any, periodStart: string, periodEnd: string): boolean {
  const start = lease.commencement_date || lease.start_date;
  const end = lease.expiration_date || lease.end_date || periodEnd;
  if (!start) return false;
  return start <= periodEnd && end >= periodStart;
}

function earliestLeaseStart(leases: any[], fallback: string): string {
  return leases
    .map((lease) => lease.commencement_date || lease.start_date)
    .filter(Boolean)
    .sort()[0] || fallback;
}

async function ensureOccupancyForScope(
  supabaseAdmin: any,
  {
    orgId,
    scopeType,
    scopeId,
    periodStart,
    periodEnd,
    effectiveFrom,
    occupiedAreaSqft,
    derivation,
  }: {
    orgId: string;
    scopeType: "property" | "building";
    scopeId: string;
    periodStart: string;
    periodEnd: string;
    effectiveFrom: string;
    occupiedAreaSqft: number | null;
    derivation: string;
  },
) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("space_occupancy_periods")
    .select("id")
    .eq("org_id", orgId)
    .eq("scope_type", scopeType)
    .eq("scope_id", scopeId)
    .lte("effective_from", periodEnd)
    .or(`effective_to.is.null,effective_to.gte.${periodStart}`)
    .limit(1);
  if (existingError) throw new Error(`Failed to inspect ${scopeType} occupancy: ${existingError.message}`);
  if ((existing || []).length > 0) return "reused";

  const { error: insertError } = await supabaseAdmin.from("space_occupancy_periods").insert({
    org_id: orgId,
    scope_type: scopeType,
    scope_id: scopeId,
    occupancy_status: "occupied",
    occupied_area_sqft: occupiedAreaSqft,
    effective_from: effectiveFrom,
    source_type: "legacy_backfill",
    backfill_confidence: 0.65,
    backfill_derivation_method: derivation,
    review_status: "needs_review",
  });
  if (insertError) {
    if (/overlap|conflict|exclusion/i.test(insertError.message || "")) return "reused";
    throw new Error(`Failed to create ${scopeType} occupancy: ${insertError.message}`);
  }
  return "created";
}

async function ensureAggregateOccupancyPeriods(
  supabaseAdmin: any,
  {
    orgId,
    propertyId,
    period,
    approvedLeases,
  }: { orgId: string; propertyId: string; period: any; approvedLeases: any[] },
) {
  const periodStart = period.start_date;
  const periodEnd = period.end_date;
  const leasesInPeriod = (approvedLeases || []).filter((lease) => leaseOverlapsPeriod(lease, periodStart, periodEnd));
  const result = { created: 0, reused: 0, skipped: 0 };
  if (leasesInPeriod.length === 0) {
    result.skipped += 1;
    return result;
  }

  const propertyArea = leasesInPeriod.reduce((sum, lease) => sum + Number(lease.square_footage || 0), 0);
  const propertyStatus = await ensureOccupancyForScope(supabaseAdmin, {
    orgId,
    scopeType: "property",
    scopeId: propertyId,
    periodStart,
    periodEnd,
    effectiveFrom: earliestLeaseStart(leasesInPeriod, periodStart),
    occupiedAreaSqft: propertyArea > 0 ? propertyArea : null,
    derivation: "Approved leases overlap selected recovery period; aggregate property occupancy backfilled so CAM readiness can evaluate gross-up inputs without a false missing-scope warning.",
  });
  result[propertyStatus] += 1;

  const leasesByBuilding = new Map<string, any[]>();
  for (const lease of leasesInPeriod) {
    if (!lease.building_id) continue;
    if (!leasesByBuilding.has(lease.building_id)) leasesByBuilding.set(lease.building_id, []);
    leasesByBuilding.get(lease.building_id)!.push(lease);
  }

  for (const [buildingId, buildingLeases] of leasesByBuilding.entries()) {
    const buildingArea = buildingLeases.reduce((sum, lease) => sum + Number(lease.square_footage || 0), 0);
    const status = await ensureOccupancyForScope(supabaseAdmin, {
      orgId,
      scopeType: "building",
      scopeId: buildingId,
      periodStart,
      periodEnd,
      effectiveFrom: earliestLeaseStart(buildingLeases, periodStart),
      occupiedAreaSqft: buildingArea > 0 ? buildingArea : null,
      derivation: "Approved leases for this building overlap selected recovery period; aggregate building occupancy backfilled so building-scoped CAM readiness can evaluate gross-up inputs without a false missing-scope warning.",
    });
    result[status] += 1;
  }

  return result;
}

export async function prepareCamAutomatically(supabaseAdmin: any, params: PrepareParams) {
  const { orgId, propertyId, recoveryPeriodId, actorUserId, actorEmail } = params;

  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties").select("*").eq("id", propertyId).eq("org_id", orgId).maybeSingle();
  if (propertyError) throw new Error(`Failed to load property: ${propertyError.message}`);
  if (!property) throw new Error("Property not found for this organization");

  const { data: period, error: periodError } = await supabaseAdmin
    .from("recovery_periods").select("*").eq("id", recoveryPeriodId).eq("org_id", orgId).maybeSingle();
  if (periodError) throw new Error(`Failed to load recovery period: ${periodError.message}`);
  if (!period) throw new Error("Recovery period not found for this organization");
  const periodStart = period.start_date;
  const periodEnd = period.end_date;

  // ---- Step 1: active approved leases for the property ----
  const { data: allLeases, error: leasesError } = await supabaseAdmin
    .from("leases").select("*").eq("org_id", orgId).eq("property_id", propertyId);
  if (leasesError) throw new Error(`Failed to load leases: ${leasesError.message}`);
  const approvedLeases = (allLeases || []).filter((l: any) => l.abstract_status === "approved" || l.status === "approved");

  // ---- Step 2: duplicate legal lease detection (report only, never merges) ----
  const duplicateLeaseGroups = detectDuplicateLeaseGroups(approvedLeases);
  const duplicateLeaseIds = new Set(duplicateLeaseGroups.filter((g) => g.likely_duplicate).flatMap((g) => g.lease_ids));

  // ---- Steps 3 + 4: effective premises/area/occupancy AND policy
  // materialization, both from backfill_cam_engine_v2_legacy_data.
  //
  // Discovered while writing this module's own tests (not assumed from the
  // RPC's name or docstring): backfill_cam_engine_v2_legacy_data's
  // "Category C" (20269900000022_cam_engine_v2_backfill_rpc.sql:161-208)
  // already loops every org+property-scoped rule with approval_status=
  // 'approved' and calls materialize_lease_recovery_policy on each one,
  // idempotently, reporting created/reused/blocked. An earlier, separate
  // step-4 loop here that called materialize_lease_recovery_policy a second
  // time was fully redundant with this -- removed once the test proved it
  // (every rule was already reused, never created, by the time that loop
  // ran). One RPC call now does both jobs; this also means the item-D root
  // cause is precisely "backfill_cam_engine_v2_legacy_data itself was never
  // invoked in production" -- not "materialize_lease_recovery_policy is
  // unreachable" as such (it IS reachable, transitively, through backfill;
  // it was simply never reached because nothing called backfill either).
  const backfillResult = await callRpc(supabaseAdmin, "backfill_cam_engine_v2_legacy_data", {
    p_org_id: orgId, p_property_id: propertyId, p_dry_run: false, p_actor_user_id: actorUserId, p_actor_email: actorEmail,
  });
  if (backfillResult.error) throw new Error(`Backfill failed: ${backfillResult.error.message}`);
  const aggregateOccupancyResult = await ensureAggregateOccupancyPeriods(supabaseAdmin, {
    orgId,
    propertyId,
    period,
    approvedLeases,
  });

  const policyBackfillReport = backfillResult.data?.report?.recovery_policies_from_rules ?? null;
  const policiesMaterializedCount = policyBackfillReport?.created ?? 0;
  const materializationBlocked = policyBackfillReport?.blocked_examples ?? [];

  // ---- Step 4b: publish every approved, recoverable, CAM-eligible rule to
  // CAM (see publishEligibleRulesToCam above for why this step exists).
  // Independent of policy materialization -- a rule can be blocked here
  // (e.g. still "conditional" recoverability) while its policy already
  // materialized fine, or vice versa.
  const { data: approvedRulesForPublish, error: approvedRulesError } = await supabaseAdmin
    .from("lease_expense_rules")
    .select("*")
    .eq("org_id", orgId)
    .eq("approval_status", "approved")
    .eq("cam_eligible", "yes")
    .in("recoverable_from_tenant", ["yes", "conditional"])
    .in("lease_id", approvedLeases.map((l: any) => l.id).length > 0 ? approvedLeases.map((l: any) => l.id) : ["00000000-0000-0000-0000-000000000000"]);
  if (approvedRulesError) throw new Error(`Failed to load lease expense rules: ${approvedRulesError.message}`);

  const rulePublishResult = await publishEligibleRulesToCam(
    supabaseAdmin, approvedRulesForPublish || [], duplicateLeaseIds, orgId, actorUserId, actorEmail,
  );

  // ---- Reload policies + steps now that materialization has run ----
  const { data: policies, error: policiesError } = await supabaseAdmin
    .from("lease_recovery_policies")
    .select("*, lease_recovery_policy_steps(*)")
    .eq("org_id", orgId)
    .in("lease_id", approvedLeases.map((l: any) => l.id).length > 0 ? approvedLeases.map((l: any) => l.id) : ["00000000-0000-0000-0000-000000000000"])
    .neq("status", "superseded");
  if (policiesError) throw new Error(`Failed to reload policies: ${policiesError.message}`);

  const approvedPolicySteps: any[] = [];
  for (const pol of policies || []) {
    if (pol.status !== "approved") continue;
    for (const step of pol.lease_recovery_policy_steps || []) approvedPolicySteps.push({ ...step, lease_id: pol.lease_id });
  }

  // ---- Step 5: finalized, CAM-eligible, published expenses overlapping the recovery period ----
  // Filtered by period, not just property -- importing every published
  // expense regardless of fiscal_year/service_period would silently mix
  // prior-year amounts into this period's setup.
  const { data: allPublished, error: expensesError } = await supabaseAdmin
    .from("cam_expense_inputs")
    .select("*")
    .eq("org_id", orgId).eq("property_id", propertyId).eq("publication_status", "published");
  if (expensesError) throw new Error(`Failed to load published expenses: ${expensesError.message}`);

  const periodYear = new Date(`${periodStart}T00:00:00Z`).getUTCFullYear();
  function overlapsPeriod(exp: any): boolean {
    if (exp.service_period_start && exp.service_period_end) {
      return exp.service_period_start <= periodEnd && exp.service_period_end >= periodStart;
    }
    if (exp.fiscal_year != null) return Number(exp.fiscal_year) === periodYear;
    return false; // no period-identifying data at all -- excluded, not guessed
  }
  const publishedExpensesInPeriod = (allPublished || []).filter(overlapsPeriod);
  const publishedExpensesOutOfPeriod = (allPublished || []).filter((e: any) => !overlapsPeriod(e));

  const { data: categories } = await supabaseAdmin.from("expense_categories").select("id, category_name, code").eq("org_id", orgId);
  const categoryNamesById = new Map((categories || []).map((c: any) => [c.id, c.category_name || c.code]));

  for (const step of approvedPolicySteps) {
    if (step.expense_category_id && !categoryNamesById.has(step.expense_category_id)) {
      if (step.category_name || step.expense_category) {
        categoryNamesById.set(step.expense_category_id, step.category_name || step.expense_category);
      }
    }
  }
  for (const exp of publishedExpensesInPeriod) {
    if (exp.expense_category_id && !categoryNamesById.has(exp.expense_category_id)) {
      if (exp.category) {
        categoryNamesById.set(exp.expense_category_id, exp.category);
      }
    }
  }

  // ---- Existing pools/categories for this property+period (so suggestions never re-suggest an already-covered category) ----
  const { data: existingPools } = await supabaseAdmin
    .from("recovery_pools").select("*, recovery_pool_categories(*)").eq("org_id", orgId).eq("property_id", propertyId).eq("period_id", recoveryPeriodId);
  const alreadyCoveredCategoryIds = new Set<string>();
  for (const pool of existingPools || []) for (const cat of pool.recovery_pool_categories || []) if (cat.inclusion_mode === "include") alreadyCoveredCategoryIds.add(cat.expense_category_id);

  // ---- Step 6: suggested recovery pools ----
  const byCategory = new Map<string, { leaseIds: Set<string>; expenseCount: number; expenseTotal: number; fromPolicy: boolean; fromExpense: boolean; expenseIds: string[] }>();
  const newCategoryEntry = () => ({ leaseIds: new Set<string>(), expenseCount: 0, expenseTotal: 0, fromPolicy: false, fromExpense: false, expenseIds: [] as string[] });
  for (const step of approvedPolicySteps) {
    if (!step.expense_category_id) continue;
    if (!["CALCULATE_SHARE", "DIRECT_ASSIGN"].includes(step.step_type)) continue;
    if (duplicateLeaseIds.has(step.lease_id)) continue; // don't let a flagged-duplicate lease drive a pool suggestion
    if (!byCategory.has(step.expense_category_id)) byCategory.set(step.expense_category_id, newCategoryEntry());
    byCategory.get(step.expense_category_id)!.leaseIds.add(step.lease_id);
    byCategory.get(step.expense_category_id)!.fromPolicy = true;
  }
  for (const exp of publishedExpensesInPeriod) {
    // Canonical category only. byCategory is keyed by
    // lease_recovery_policy_steps.expense_category_id (a UUID), so keying it
    // by the free-text label here produced categories that matched no policy
    // and no pool (specification 8.3, 16). An input with no canonical
    // category is reported below as a blocker rather than silently keyed by
    // its label.
    if (!exp.expense_category_id) continue;
    if (!byCategory.has(exp.expense_category_id)) byCategory.set(exp.expense_category_id, newCategoryEntry());
    const entry = byCategory.get(exp.expense_category_id)!;
    entry.expenseCount += 1;
    entry.expenseTotal += Number(exp.amount || 0);
    entry.fromExpense = true;
    entry.expenseIds.push(exp.id);
  }
  const suggestedPools = [...byCategory.entries()]
    .filter(([categoryId]) => !alreadyCoveredCategoryIds.has(categoryId))
    .map(([categoryId, entry]) => ({
      expense_category_id: categoryId,
      category_name: categoryNamesById.get(categoryId) ?? null,
      policy_lease_count: entry.leaseIds.size,
      expense_count: entry.expenseCount,
      expense_total: entry.expenseTotal,
      // Provenance (specification step G): every suggestion states the exact
      // canonical category UUID and the scope match that produced it, so a
      // reviewer can verify rather than trust it.
      source: entry.fromPolicy && entry.fromExpense ? "policy_and_expense" : entry.fromPolicy ? "policy" : "expense",
      matched_on: { field: "expense_category_id", value: categoryId },
      scope_match: { property_id: propertyId, recovery_period_id: recoveryPeriodId, period_start: periodStart, period_end: periodEnd },
      source_expense_input_ids: entry.expenseIds,
      match_explanation:
        `Canonical expense_category_id ${categoryId}`
        + (entry.fromPolicy ? ` matched ${entry.leaseIds.size} approved lease policy step(s)` : "")
        + (entry.fromPolicy && entry.fromExpense ? " and" : "")
        + (entry.fromExpense ? ` matched ${entry.expenseCount} published expense(s) totalling ${entry.expenseTotal.toFixed(2)}` : "")
        + ` within property ${propertyId} for period ${periodStart}..${periodEnd}.`,
    }))
    .sort((a, b) => b.expense_total - a.expense_total);

  // ---- Step 7: suggested participants per suggested (or existing) pool, from premises/scope/policy eligibility ----
  const { data: leasePremisesRows } = await supabaseAdmin
    .from("lease_premises")
    .select("*, lease_premises_spaces(*), lease_premises_area_periods(*)")
    .in("lease_id", approvedLeases.map((l: any) => l.id).length > 0 ? approvedLeases.map((l: any) => l.id) : ["00000000-0000-0000-0000-000000000000"])
    .neq("status", "superseded");

  function datesOverlap(aStart: any, aEnd: any, bStart: any, bEnd: any) {
    if (aStart && bEnd && aStart > bEnd) return false;
    if (bStart && aEnd && bStart > aEnd) return false;
    return true;
  }

  function suggestParticipantsForCategory(categoryId: string) {
    const leaseCategoryIds = new Map<string, Set<string>>();
    for (const step of approvedPolicySteps) {
      if (!step.expense_category_id) continue;
      if (!["CALCULATE_SHARE", "DIRECT_ASSIGN"].includes(step.step_type)) continue;
      if (!leaseCategoryIds.has(step.lease_id)) leaseCategoryIds.set(step.lease_id, new Set());
      leaseCategoryIds.get(step.lease_id)!.add(step.expense_category_id);
    }
    const leaseById = new Map(approvedLeases.map((l: any) => [l.id, l]));
    const suggestions: any[] = [];
    for (const premises of leasePremisesRows || []) {
      const lease = leaseById.get(premises.lease_id);
      if (!lease) continue;
      if (duplicateLeaseIds.has(lease.id)) continue; // excluded pending manual lease consolidation
      if (!datesOverlap(premises.effective_from, premises.effective_to, periodStart, periodEnd)) continue;
      const categoriesForLease = leaseCategoryIds.get(lease.id);
      if (!categoriesForLease || !categoriesForLease.has(categoryId)) continue;
      const spaces = premises.lease_premises_spaces || [];
      const inProperty = spaces.some((sp: any) => sp.property_id === propertyId);
      if (!inProperty) continue;
      const areaPeriods = premises.lease_premises_area_periods || [];
      const currentArea = areaPeriods.find((ap: any) => datesOverlap(ap.effective_from, ap.effective_to, periodStart, periodEnd));
      suggestions.push({
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        premises_id: premises.id,
        effective_area_sqft: currentArea?.recovery_area_sqft ?? null,
        reason: "Approved policy includes this category; premises overlap this recovery period.",
        // Provenance (specification step G).
        matched_on: { field: "expense_category_id", value: categoryId },
        scope_match: {
          property_id: propertyId,
          premises_effective_from: premises.effective_from,
          premises_effective_to: premises.effective_to,
          period_start: periodStart,
          period_end: periodEnd,
        },
        match_explanation:
          `Lease ${lease.id} has an approved policy step for canonical expense_category_id ${categoryId}, `
          + `and premises ${premises.id} sits in property ${propertyId} overlapping ${periodStart}..${periodEnd}.`,
      });
    }
    return suggestions;
  }

  const suggestedParticipantsByCategory: Record<string, any[]> = {};
  for (const pool of suggestedPools) suggestedParticipantsByCategory[pool.expense_category_id] = suggestParticipantsForCategory(pool.expense_category_id);
  for (const pool of existingPools || []) {
    for (const cat of pool.recovery_pool_categories || []) {
      if (cat.inclusion_mode !== "include") continue;
      suggestedParticipantsByCategory[cat.expense_category_id] = suggestParticipantsForCategory(cat.expense_category_id);
    }
  }

  // ---- Step 8: suggested expense-to-pool assignments ----
  const { data: existingAssignments } = await supabaseAdmin
    .from("cam_input_pool_assignments").select("cam_expense_input_id, amount")
    .in("cam_expense_input_id", publishedExpensesInPeriod.map((e: any) => e.id).length > 0 ? publishedExpensesInPeriod.map((e: any) => e.id) : ["00000000-0000-0000-0000-000000000000"]);
  const assignedByExpenseId = new Map<string, number>();
  for (const a of existingAssignments || []) assignedByExpenseId.set(a.cam_expense_input_id, (assignedByExpenseId.get(a.cam_expense_input_id) ?? 0) + Number(a.amount || 0));

  const poolsByCategoryId = new Map<string, any[]>();
  for (const pool of existingPools || []) for (const cat of pool.recovery_pool_categories || []) if (cat.inclusion_mode === "include") {
    if (!poolsByCategoryId.has(cat.expense_category_id)) poolsByCategoryId.set(cat.expense_category_id, []);
    poolsByCategoryId.get(cat.expense_category_id)!.push(pool);
  }

  const suggestedAssignments: any[] = [];
  const unassignedNoSuggestion: any[] = [];
  for (const exp of publishedExpensesInPeriod) {
    const alreadyAssigned = assignedByExpenseId.get(exp.id) ?? 0;
    const unassignedBalance = Number(exp.amount || 0) - alreadyAssigned;
    if (unassignedBalance <= 0.005) continue;
    const candidatePools = exp.expense_category_id ? (poolsByCategoryId.get(exp.expense_category_id) ?? []) : [];
    if (candidatePools.length === 1) {
      suggestedAssignments.push({
        cam_expense_input_id: exp.id,
        recovery_pool_id: candidatePools[0].id,
        pool_name: candidatePools[0].name,
        amount: unassignedBalance,
        // Provenance (specification step G): the exact category UUID and the
        // pool/period scope that made this the single candidate.
        matched_on: { field: "expense_category_id", value: exp.expense_category_id },
        scope_match: {
          property_id: propertyId,
          recovery_period_id: recoveryPeriodId,
          pool_scope_type: candidatePools[0].scope_type ?? null,
          pool_scope_id: candidatePools[0].scope_id ?? null,
        },
        match_explanation:
          `Published input ${exp.id} carries canonical expense_category_id ${exp.expense_category_id}, which pool `
          + `"${candidatePools[0].name}" includes and no other pool in this period accepts.`,
      });
    } else {
      unassignedNoSuggestion.push({
        cam_expense_input_id: exp.id,
        expense_category_id: exp.expense_category_id ?? null,
        category: exp.category,
        amount: unassignedBalance,
        candidate_pool_count: candidatePools.length,
        reason: exp.expense_category_id ? (candidatePools.length === 0 ? "NO_POOL_ACCEPTS_CATEGORY" : "MULTIPLE_CANDIDATE_POOLS") : "EXPENSE_CATEGORY_MISSING",
      });
    }
  }

  // ---- Step 9: existing estimate schedules for the period ----
  const { data: estimateSchedules } = await supabaseAdmin
    .from("cam_estimate_schedules").select("id, lease_id, amount").eq("org_id", orgId).eq("recovery_period_id", recoveryPeriodId);

  // ---- Step 10: readiness ----
  const readiness = await callRpc(supabaseAdmin, "evaluate_cam_readiness", {
    p_org_id: orgId, p_property_id: propertyId, p_recovery_period_id: recoveryPeriodId, p_scope_type: "property", p_scope_id: propertyId,
  });
  if (readiness.error) throw new Error(`Readiness check failed: ${readiness.error.message}`);

  // ---- Step 11: structured result ----
  // Source counts and monetary totals (specification 10.2 / step G). These
  // make "empty" states self-explaining: a reviewer can see whether Setup is
  // empty because no source data exists, or because it exists and did not
  // resolve.
  const publishedAmountInPeriod = publishedExpensesInPeriod.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
  const uncategorizedInPeriod = publishedExpensesInPeriod.filter((e: any) => !e.expense_category_id && Math.abs(Number(e.amount ?? 0)) > 0);
  const uncategorizedAmount = uncategorizedInPeriod.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
  const assignedAmount = [...assignedByExpenseId.values()].reduce((s: number, v: number) => s + v, 0);
  const counts = {
    approved_leases: approvedLeases.length,
    duplicate_groups: duplicateLeaseGroups.length,
    calculation_ready_policies: (policies || []).length,
    published_expenses: publishedExpensesInPeriod.length,
    published_amount: publishedAmountInPeriod.toFixed(2),
    assigned_amount: assignedAmount.toFixed(2),
    unassigned_amount: (publishedAmountInPeriod - assignedAmount).toFixed(2),
    categorized_expenses: publishedExpensesInPeriod.length - uncategorizedInPeriod.length,
    uncategorized_expenses: uncategorizedInPeriod.length,
    uncategorized_amount: uncategorizedAmount.toFixed(2),
    published_expenses_outside_period: publishedExpensesOutOfPeriod.length,
    suggested_pools: suggestedPools.length,
    suggested_assignments: suggestedAssignments.length,
    estimate_schedules: (estimateSchedules || []).length,
  };

  return {
    property_id: propertyId,
    recovery_period_id: recoveryPeriodId,
    counts,
    created: {
      backfill: backfillResult.data?.report ?? null,
      aggregate_occupancy_periods: aggregateOccupancyResult,
      policies_materialized: policiesMaterializedCount,
      rules_published_to_cam: rulePublishResult.published,
      rules_already_published_to_cam: rulePublishResult.alreadyPublished,
    },
    suggested: {
      pools: suggestedPools,
      participants_by_category: suggestedParticipantsByCategory,
      expense_assignments: suggestedAssignments,
    },
    missing: {
      leases_without_any_policy: approvedLeases.filter((l: any) => !(policies || []).some((p: any) => p.lease_id === l.id)).map((l: any) => ({ lease_id: l.id, tenant_name: l.tenant_name })),
      unassigned_expenses_no_single_candidate: unassignedNoSuggestion,
      // Published inputs whose text label did not resolve to exactly one
      // canonical category. These cannot drive a pool suggestion or an
      // assignment and would otherwise vanish from Setup entirely; surfacing
      // them keeps the source count honest and gives the user a direct
      // action (specification 11.2, 18.2, 27).
      // Scoped to published, period-overlapping, financially material
      // (nonzero) inputs only — a zero-amount input cannot change a recovery,
      // so it must not raise a blocker (specification 18.1).
      published_expenses_without_canonical_category: publishedExpensesInPeriod
        .filter((e: any) => !e.expense_category_id && Math.abs(Number(e.amount ?? 0)) > 0)
        .map((e: any) => ({ id: e.id, category_label: e.category ?? null, amount: e.amount, code: "EXPENSE_CATEGORY_MISSING" })),
      published_expenses_outside_period: publishedExpensesOutOfPeriod.map((e: any) => ({ id: e.id, fiscal_year: e.fiscal_year, service_period_start: e.service_period_start, service_period_end: e.service_period_end, amount: e.amount })),
      rules_not_publishable_to_cam: rulePublishResult.notPublishable,
    },
    conflicting: {
      duplicate_lease_groups: duplicateLeaseGroups,
      materialization_blocked: materializationBlocked,
    },
    blocking: (readiness.data?.exceptions ?? []).filter((e: any) => e.severity === "blocking"),
    readiness: readiness.data,
    estimate_schedule_count: (estimateSchedules || []).length,
  };
}
