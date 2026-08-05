/**
 * camReadiness — normalizes the REAL evaluate_cam_readiness RPC response
 * (via get-cam-setup-readiness) into a display-ready shape, adds
 * SETUP-UI-ONLY supplementary checks the frozen readiness engine does not
 * perform (expense category / service-period gaps), and computes the
 * automatic recovery-period suggestion. Never alters or re-implements the
 * engine's own readiness logic -- only labels and supplements it.
 */
import { readinessExceptionLabel } from "@/lib/camLabels";

/**
 * @param {object} rpcReadiness - the raw evaluate_cam_readiness output: {ready, blocking_count, warning_count, exceptions:[{severity,code,entity_type,entity_id,message}]}
 * @returns {{ready:boolean, blockingCount:number, warningCount:number, items:Array}}
 */
export function normalizeReadiness(rpcReadiness) {
  const exceptions = rpcReadiness?.exceptions ?? [];
  const items = exceptions.map((e) => ({
    severity: e.severity,
    code: e.code,
    entityType: e.entity_type,
    entityId: e.entity_id,
    message: readinessExceptionLabel(e.code, e.message),
    rawMessage: e.message,
    source: "engine",
  }));
  return {
    ready: Boolean(rpcReadiness?.ready),
    blockingCount: rpcReadiness?.blocking_count ?? items.filter((i) => i.severity === "blocking").length,
    warningCount: rpcReadiness?.warning_count ?? items.filter((i) => i.severity === "warning").length,
    items,
  };
}

/**
 * Setup-UI-only supplementary checks: category and service-period gaps on
 * PUBLISHED expenses. The frozen evaluate_cam_readiness RPC does not check
 * these, so they are computed here, client-side, read-only, and merged
 * alongside (never instead of) the engine's own exceptions.
 */
/**
 * True when the loaded rows actually carry the canonical category column.
 *
 * Migration 039 adds cam_expense_inputs.expense_category_id. Until it is
 * deployed to a given environment the field is simply absent from the payload,
 * and `!row.expense_category_id` would be true for EVERY row — turning a
 * correct blocker into a false-blocker storm across the whole property. So the
 * canonical check is only applied where the column demonstrably exists.
 * Deliberately checks property presence, not truthiness: a legitimately
 * unresolved row has the property set to null, which must still be flagged.
 */
export function hasCanonicalCategoryColumn(rows) {
  return (rows || []).some((r) => r && Object.prototype.hasOwnProperty.call(r, "expense_category_id"));
}

export function computeExpenseGapExceptions(publishedExpenses) {
  const items = [];
  const canonicalAvailable = hasCanonicalCategoryColumn(publishedExpenses);
  for (const exp of publishedExpenses || []) {
    // Blocking condition is the missing CANONICAL category, not the missing
    // label. Pools and policies match on expense_category_id, so an expense
    // carrying a label such as 'Insurance' that never resolved to exactly one
    // category is just as unusable as one with no label at all — and the
    // engine already blocks it. Checking the label alone let that case pass
    // Setup and then fail in the run (specification 8.3, 18.1).
    // Scope: a published, financially material (nonzero) expense only. A
    // zero-amount input cannot change any recovery, so blocking Setup on its
    // category would be an irrelevant blocker (specification 18.1: every
    // issue must be scoped to actual financial relevance). Property/period
    // scoping is applied by the caller's query before this runs.
    const isMaterial = Math.abs(Number(exp.amount ?? 0)) > 0;
    // Pre-039 environments fall back to the label-presence check, which is the
    // most this schema can honestly assert there.
    const categoryMissing = canonicalAvailable ? !exp.expense_category_id : !exp.category;
    if (categoryMissing && isMaterial) {
      items.push({
        severity: "blocking", code: "EXPENSE_CATEGORY_MISSING", entityType: "cam_expense_inputs", entityId: exp.id,
        message: readinessExceptionLabel("EXPENSE_CATEGORY_MISSING"),
        rawMessage: exp.category
          ? `Expense ${exp.id} has the category label "${exp.category}" but it does not resolve to exactly one canonical expense category`
          : `Expense ${exp.id} has no category`,
        source: "setup_ui",
      });
    }
    if (!exp.service_period_start || !exp.service_period_end) {
      items.push({
        severity: "warning", code: "EXPENSE_SERVICE_PERIOD_MISSING", entityType: "cam_expense_inputs", entityId: exp.id,
        message: readinessExceptionLabel("EXPENSE_SERVICE_PERIOD_MISSING"), rawMessage: `Expense ${exp.id} has no service period`, source: "setup_ui",
      });
    }
  }
  return items;
}

/** Merges engine + setup-UI checks into one list and recomputes the totals. */
export function mergeReadiness(engineReadiness, supplementaryItems) {
  const items = [...engineReadiness.items, ...(supplementaryItems || [])];
  const blockingCount = items.filter((i) => i.severity === "blocking").length;
  const warningCount = items.filter((i) => i.severity === "warning").length;
  return { ready: blockingCount === 0, blockingCount, warningCount, items };
}

/**
 * Computes the current calendar-year (or fiscal-year, per
 * fiscal_start_month) recovery-period window for a recovery_calendars row,
 * for the one-click "suggested recovery period" confirmation.
 */
export function suggestedPeriodForCalendar(calendar, today = new Date()) {
  const fiscalStartMonth = calendar?.fiscal_start_month ?? 1;
  const year = today.getFullYear();
  // If today is before this year's fiscal start month, the "current"
  // fiscal year began the PRIOR calendar year.
  const startYear = today.getMonth() + 1 < fiscalStartMonth ? year - 1 : year;
  const startDate = new Date(Date.UTC(startYear, fiscalStartMonth - 1, 1));
  const endDate = new Date(Date.UTC(startYear + 1, fiscalStartMonth - 1, 0)); // last day of the month before next start
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return {
    start_date: iso(startDate),
    end_date: iso(endDate),
    label: `FY${startYear}`,
    displayText: `${fmt(startDate)} – ${fmt(endDate)}`,
  };
}
