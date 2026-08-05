/**
 * camSuggestions — pure, read-only derivation of recovery-pool and
 * lease-participant SUGGESTIONS from already-approved data (materialized
 * policies, published expenses, lease premises). These functions never
 * write anything and never influence the calculation engine; they only
 * propose candidates for a human to confirm, rename, combine, or dismiss.
 * Explicit confirmation (a real recovery_pool_categories row / a real
 * recovery_pool_lease_participants row) remains the only authority.
 */
import { suggestedPoolNameForCategory } from "@/lib/camLabels";

/**
 * @param {object[]} approvedPolicySteps - lease_recovery_policy_steps rows (joined lease_recovery_policies.status='approved'), each carrying policy.lease_id
 * @param {object[]} publishedExpenses - cam_expense_inputs rows, publication_status='published'
 * @param {Map<string,string>} categoryNamesById
 * @param {Set<string>} alreadyCoveredCategoryIds - expense_category_id values already assigned to an existing pool for this period
 * @returns {Array<{expense_category_id, category_name, suggested_pool_name, policy_lease_count, expense_count, expense_total}>}
 */
export function suggestPools(approvedPolicySteps, publishedExpenses, categoryNamesById, alreadyCoveredCategoryIds) {
  const byCategory = new Map();

  for (const step of approvedPolicySteps || []) {
    if (!step.expense_category_id) continue;
    if (!["CALCULATE_SHARE", "DIRECT_ASSIGN"].includes(step.step_type)) continue;
    const key = step.expense_category_id;
    if (!byCategory.has(key)) byCategory.set(key, { leaseIds: new Set(), expenseCount: 0, expenseTotal: 0, fromPolicy: false, fromExpense: false });
    byCategory.get(key).leaseIds.add(step.lease_id);
    byCategory.get(key).fromPolicy = true;
  }

  // Migration 039 adds cam_expense_inputs.expense_category_id. Where it is not
  // yet deployed the field is absent from every row; in that case expenses
  // simply cannot contribute a canonical-keyed suggestion, and the caller is
  // told so through `canonical_category_available` rather than being shown a
  // silently short list. Falling back to label matching here is exactly the
  // defect 039 exists to remove, so it is deliberately NOT done.
  const canonicalAvailable = (publishedExpenses || []).some(
    (r) => r && Object.prototype.hasOwnProperty.call(r, "expense_category_id"),
  );

  for (const exp of publishedExpenses || []) {
    // Canonical category only. This map is keyed by
    // lease_recovery_policy_steps.expense_category_id (a UUID); keying it by
    // the free-text label produced phantom "categories" that matched no
    // policy and no pool. An input with no canonical category is reported
    // through EXPENSE_CATEGORY_MISSING instead of inventing a pool for it.
    if (!exp.expense_category_id) continue;
    const key = exp.expense_category_id;
    if (!byCategory.has(key)) byCategory.set(key, { leaseIds: new Set(), expenseCount: 0, expenseTotal: 0, fromPolicy: false, fromExpense: false });
    const entry = byCategory.get(key);
    entry.expenseCount += 1;
    entry.expenseTotal += Number(exp.amount || 0);
    entry.fromExpense = true;
  }

  const suggestions = [];
  for (const [categoryId, entry] of byCategory.entries()) {
    if (alreadyCoveredCategoryIds?.has(categoryId)) continue;
    const categoryName = categoryNamesById?.get(categoryId) ?? null;
    // Provenance: which source produced this suggestion, so the user can see
    // exactly why it appeared rather than trusting an unexplained row.
    const source = entry.fromPolicy && entry.fromExpense
      ? "policy_and_expense"
      : entry.fromPolicy ? "policy" : "expense";
    suggestions.push({
      expense_category_id: categoryId,
      category_name: categoryName,
      suggested_pool_name: suggestedPoolNameForCategory(categoryName) + " Pool",
      policy_lease_count: entry.leaseIds.size,
      expense_count: entry.expenseCount,
      expense_total: entry.expenseTotal,
      source,
      canonical_category_available: canonicalAvailable,
      match_explanation: `Matched on canonical expense_category_id ${categoryId}`
        + (entry.fromPolicy ? ` · ${entry.leaseIds.size} approved policy step(s)` : "")
        + (entry.fromExpense ? ` · ${entry.expenseCount} published expense(s)` : ""),
    });
  }
  return suggestions.sort((a, b) => (b.expense_total - a.expense_total) || (b.policy_lease_count - a.policy_lease_count));
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  const s1 = aStart ? new Date(aStart) : null;
  const e1 = aEnd ? new Date(aEnd) : null;
  const s2 = bStart ? new Date(bStart) : null;
  const e2 = bEnd ? new Date(bEnd) : null;
  if (s1 && e2 && s1 > e2) return false;
  if (s2 && e1 && s2 > e1) return false;
  return true;
}

/**
 * @param {object} pool - recovery_pools row (scope_type/scope_id/property_id)
 * @param {object[]} leases - leases rows for the property
 * @param {object[]} leasePremises - lease_premises rows (status='approved') with nested spaces[] and areaPeriods[]
 * @param {object[]} approvedPolicySteps - lease_recovery_policy_steps rows (approved policies only), category-bearing
 * @param {Set<string>} poolCategoryIds - expense_category_id values this pool includes
 * @param {object[]} existingParticipants - recovery_pool_lease_participants rows for this pool (any status)
 * @param {{start_date:string, end_date:string}} period
 * @returns {Array<{lease_id, tenant_name, premises_id, effective_area_sqft, lease_start, lease_end, already_participant, reason}>}
 */
export function suggestParticipants(pool, leases, leasePremises, approvedPolicySteps, poolCategoryIds, existingParticipants, period) {
  const leaseById = new Map((leases || []).map((l) => [l.id, l]));
  const activeParticipantLeaseIds = new Set((existingParticipants || []).filter((p) => p.status === "active").map((p) => p.lease_id));
  const leaseCategoryIds = new Map();
  for (const step of approvedPolicySteps || []) {
    if (!step.expense_category_id) continue;
    if (!["CALCULATE_SHARE", "DIRECT_ASSIGN"].includes(step.step_type)) continue;
    if (!leaseCategoryIds.has(step.lease_id)) leaseCategoryIds.set(step.lease_id, new Set());
    leaseCategoryIds.get(step.lease_id).add(step.expense_category_id);
  }

  const suggestions = [];
  for (const premises of leasePremises || []) {
    if (premises.status !== "approved") continue;
    const lease = leaseById.get(premises.lease_id);
    if (!lease) continue;
    if (activeParticipantLeaseIds.has(lease.id)) continue;
    if (!datesOverlap(premises.effective_from, premises.effective_to, period?.start_date, period?.end_date)) continue;

    const spaces = premises.spaces || premises.lease_premises_spaces || [];
    const inScope = spaces.some((sp) => {
      if (pool.scope_type === "building") return sp.building_id === pool.scope_id;
      if (pool.scope_type === "property") return sp.property_id === pool.property_id;
      return false;
    });
    if (!inScope) continue;

    const categoriesForLease = leaseCategoryIds.get(lease.id);
    const categoryMatch = categoriesForLease && poolCategoryIds && [...categoriesForLease].some((c) => poolCategoryIds.has(c));
    if (poolCategoryIds && poolCategoryIds.size > 0 && !categoryMatch) continue;

    const areaPeriods = premises.areaPeriods || premises.lease_premises_area_periods || [];
    const currentArea = areaPeriods.find((ap) => datesOverlap(ap.effective_from, ap.effective_to, period?.start_date, period?.end_date));

    const reasons = [];
    reasons.push(pool.scope_type === "building" ? "Premises located in this pool's building" : "Premises located at this property");
    if (categoryMatch) reasons.push("Lease's approved policy includes a category this pool covers");
    reasons.push("Premises effective dates overlap this recovery period");

    suggestions.push({
      lease_id: lease.id,
      tenant_name: lease.tenant_name || lease.id.slice(0, 8),
      premises_id: premises.id,
      effective_area_sqft: currentArea?.recovery_area_sqft ?? null,
      lease_start: lease.start_date,
      lease_end: lease.end_date,
      already_participant: false,
      reason: reasons.join("; "),
    });
  }
  return suggestions;
}
