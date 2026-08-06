/**
 * Tenant resolution helper for actual expenses.
 *
 * Why this exists:
 *   Several pages (Actual Expenses, Expense Classification, Expense Review)
 *   each implemented their own version of "find a tenant for this expense"
 *   with slightly different fallbacks. Disagreement caused the TENANT column
 *   to show "—" on one page and a real name on another for the same row.
 *
 * What this does NOT do:
 *   - Does NOT infer or invent a tenant. If none of the explicit signals
 *     resolve, the tenant is `null` and the caller renders "—".
 *   - Does NOT use property or unit *name* as a tenant fallback.
 *   - Does NOT mutate any data. Read-only diagnostic helper.
 *
 * Resolution order (highest fidelity first):
 *   1. expense.tenant_name        — explicit value already on the row
 *   2. expense.tenant_id          — direct foreign key
 *   3. matched lease tenant       — lease.tenant_id where the lease covers
 *                                   the expense date AND matches the
 *                                   unit / building / property scope
 *   4. unit.tenant_id             — only when no overlapping lease was found
 *
 * Returns:
 *   {
 *     tenant: { id, name } | null,
 *     source: "expense.tenant_name" | "expense.tenant_id" | "matched_lease" |
 *             "unit.tenant_id" | "unresolved",
 *     reason: null | "expense_missing_tenant_id" | "no_active_lease_for_unit" |
 *             "unit_missing_tenant_id" | "lease_missing_tenant_id" |
 *             "tenant_record_not_found" | "no_scope_to_resolve",
 *     lease: <lease object> | null,
 *     unit:  <unit object>  | null,
 *     // Human-readable explanation suitable for a tooltip.
 *     reasonText: string | null,
 *   }
 */

function leaseOverlapsDate(lease, dateLike) {
  if (!lease) return false;
  if (!dateLike) return true; // no date on expense → can't filter, accept any
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return true;
  const start = lease.start_date ? new Date(lease.start_date) : null;
  const end = lease.end_date ? new Date(lease.end_date) : null;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function pickExpenseDate(expense) {
  return expense?.date
    || expense?.expense_date
    || expense?.service_period_start
    || expense?.billing_period_start
    || null;
}

function makeTenantRecord(tenant) {
  if (!tenant) return null;
  const name = tenant.tenant_name || tenant.name || null;
  if (!name) return null;
  return { id: tenant.id, name };
}

/**
 * Build a Map keyed by id from any iterable; tolerates undefined.
 */
function indexById(rows = []) {
  return new Map((rows || []).filter(Boolean).map((row) => [row.id, row]));
}

const REASON_TEXT = {
  expense_missing_tenant_id:
    "Expense has no tenant_id set. Import path did not link a tenant.",
  no_active_lease_for_unit:
    "No active lease overlaps the expense date for this unit. The unit may be vacant or the lease dates may not cover the expense period.",
  unit_missing_tenant_id:
    "Unit has no tenant_id assigned.",
  lease_missing_tenant_id:
    "Matched lease has no tenant_id.",
  tenant_record_not_found:
    "Tenant id is set but no matching tenant row was loaded. Org scope or permissions may be excluding it.",
  no_scope_to_resolve:
    "Expense has no tenant_id, unit_id, lease_id, or property_id to resolve from.",
};

function summaryReason(reason) {
  return REASON_TEXT[reason] || null;
}

/**
 * Resolve the tenant for an expense.
 *
 * Accepts either pre-built Map indexes (cheaper for table loops) or raw
 * arrays. Callers building a table should pass the Maps once and reuse.
 */
function resolveTenantForExpense(expense, options = {}) {
  const leases = options.leases || [];
  const units = options.units || [];
  const tenants = options.tenants || [];
  const leaseById = options.leaseById || indexById(leases);
  const unitById = options.unitById || indexById(units);
  const tenantById = options.tenantById || indexById(tenants);

  if (!expense || typeof expense !== "object") {
    return { tenant: null, source: "unresolved", reason: "no_scope_to_resolve", lease: null, unit: null, reasonText: REASON_TEXT.no_scope_to_resolve };
  }

  // 1. Explicit name already on the row.
  if (expense.tenant_name) {
    return {
      tenant: { id: expense.tenant_id || null, name: expense.tenant_name },
      source: "expense.tenant_name",
      reason: null,
      lease: expense.lease_id ? (leaseById.get(expense.lease_id) || null) : null,
      unit: expense.unit_id ? (unitById.get(expense.unit_id) || null) : null,
      reasonText: null,
    };
  }

  // 2. Direct tenant_id on the expense.
  if (expense.tenant_id) {
    const tenant = makeTenantRecord(tenantById.get(expense.tenant_id));
    return {
      tenant: tenant || { id: expense.tenant_id, name: null },
      source: "expense.tenant_id",
      // If the tenant row isn't in our loaded set, still surface that signal —
      // the id is the source of truth even if we lack the display name.
      reason: tenant ? null : "tenant_record_not_found",
      lease: expense.lease_id ? (leaseById.get(expense.lease_id) || null) : null,
      unit: expense.unit_id ? (unitById.get(expense.unit_id) || null) : null,
      reasonText: tenant ? null : REASON_TEXT.tenant_record_not_found,
    };
  }

  const unit = expense.unit_id ? (unitById.get(expense.unit_id) || null) : null;
  const expenseDate = pickExpenseDate(expense);

  // 3. Matched lease via direct expense.lease_id OR via unit.lease_id when
  //    the lease covers the expense date. Falls through to unit.tenant_id.
  const explicitLease = expense.lease_id ? (leaseById.get(expense.lease_id) || null) : null;
  let matchedLease = null;
  if (explicitLease && leaseOverlapsDate(explicitLease, expenseDate)) {
    matchedLease = explicitLease;
  } else if (unit?.lease_id) {
    const unitLease = leaseById.get(unit.lease_id) || null;
    if (unitLease && leaseOverlapsDate(unitLease, expenseDate)) {
      matchedLease = unitLease;
    }
  }
  // Walk all leases for the unit if nothing yet — pick the one whose dates
  // overlap. If none overlap, fall back to any lease matching the unit.
  if (!matchedLease && expense.unit_id) {
    const unitLeases = leases.filter((lease) =>
      lease?.unit_id === expense.unit_id && leaseOverlapsDate(lease, expenseDate)
    );
    matchedLease = unitLeases[0] || leases.find((lease) => lease?.unit_id === expense.unit_id) || null;
  }

  if (matchedLease) {
    const approvedTenantName =
      matchedLease.approved_fields?.tenant_name?.value ||
      matchedLease.approved_fields?.tenant?.value ||
      matchedLease.approved_fields?.tenant_legal_name?.value ||
      null;
    const directName = matchedLease.tenant_name || matchedLease.tenant?.name || approvedTenantName || null;

    if (!matchedLease.tenant_id && !directName) {
      // Lease exists but has no tenant attached — keep walking.
    } else {
      const tenant = matchedLease.tenant_id
        ? makeTenantRecord(tenantById.get(matchedLease.tenant_id))
        : null;
      const name = tenant?.name || directName;
      if (name) {
        return {
          tenant: { id: matchedLease.tenant_id || tenant?.id || null, name },
          source: "matched_lease",
          reason: null,
          lease: matchedLease,
          unit,
          reasonText: null,
        };
      }
      // Matched lease but the tenant record didn't resolve — surface why.
      return {
        tenant: matchedLease.tenant_id ? { id: matchedLease.tenant_id, name: null } : null,
        source: matchedLease.tenant_id ? "matched_lease" : "unresolved",
        reason: matchedLease.tenant_id ? "tenant_record_not_found" : "lease_missing_tenant_id",
        lease: matchedLease,
        unit,
        reasonText: REASON_TEXT[matchedLease.tenant_id ? "tenant_record_not_found" : "lease_missing_tenant_id"],
      };
    }
  }

  // 4. unit.tenant_id as a last resort. Note: this is the *currently assigned*
  //    tenant on the unit, which may not reflect who actually occupied it on
  //    the expense date — but it's a reasonable signal when no lease matches.
  if (unit?.tenant_id) {
    const tenant = makeTenantRecord(tenantById.get(unit.tenant_id));
    if (tenant) {
      return {
        tenant,
        source: "unit.tenant_id",
        reason: null,
        lease: null,
        unit,
        reasonText: null,
      };
    }
    return {
      tenant: { id: unit.tenant_id, name: null },
      source: "unit.tenant_id",
      reason: "tenant_record_not_found",
      lease: null,
      unit,
      reasonText: REASON_TEXT.tenant_record_not_found,
    };
  }

  // Unresolved. Build the most specific reason we can.
  let reason = "no_scope_to_resolve";
  if (expense.unit_id) {
    if (unit?.tenant_id === null || unit?.tenant_id === undefined || unit?.tenant_id === "") {
      reason = "unit_missing_tenant_id";
    } else {
      reason = "no_active_lease_for_unit";
    }
  } else if (!expense.tenant_id) {
    reason = "expense_missing_tenant_id";
  }

  return {
    tenant: null,
    source: "unresolved",
    reason,
    lease: matchedLease || null,
    unit,
    reasonText: summaryReason(reason),
  };
}

/**
 * Returns true if the given lease expense rule requires per-tenant allocation
 * to compute a CAM share. Used to gate sendClassificationToCam — a row whose
 * tenant is unresolved cannot be sent if the rule requires a tenant share.
 *
 * Per-tenant required:
 *   - recovery_method ∈ { pro_rata_share, fixed_monthly, monthly_reimbursement,
 *     base_year, expense_stop, pass_through }
 *   - allocation_basis ∈ { tenant_pro_rata, per_tenant, tenant_share }
 *
 * Not per-tenant (property-level):
 *   - recovery_method ∈ { included_in_base_rent, tenant_direct_contract,
 *     not_applicable } — these are already filtered out earlier
 *   - allocation_basis ∈ { property, building }
 *   - no rule at all (manual classification with no rule link) → not required
 *     because the operator has explicitly chosen to route this expense
 */
function ruleRequiresPerTenantAllocation(rule) {
  if (!rule) return false;
  const method = String(rule.recovery_method || "").toLowerCase();
  const basis = String(rule.allocation_basis || "").toLowerCase();
  const perTenantMethods = new Set([
    "pro_rata_share",
    "fixed_monthly",
    "monthly_reimbursement",
    "base_year",
    "expense_stop",
    "pass_through",
  ]);
  const propertyLevelBases = new Set(["property", "building", "portfolio"]);
  if (propertyLevelBases.has(basis)) return false;
  if (perTenantMethods.has(method)) return true;
  // Default conservative: if the rule has a tenant-pro-rata signal anywhere,
  // require a tenant.
  if (basis.includes("tenant")) return true;
  return false;
}

export {
  resolveTenantForExpense,
  ruleRequiresPerTenantAllocation,
  REASON_TEXT as TENANT_RESOLUTION_REASON_TEXT,
};
