/**
 * Reconciliation Controller — Orchestrates Budget vs Actuals Reconciliation
 *
 * Fetches budget and actual data, compares them, and generates
 * a reconciliation report with variance analysis.
 */

import { BudgetService, ExpenseService, ReconciliationService } from '@/services/api';

/**
 * Run a reconciliation for a property and period.
 *
 * @param {string} propertyId
 * @param {object} period - { fiscalYear, month? }
 * @returns {Promise<{ report: object, saved: object }>}
 */
export async function runReconciliation(propertyId, period) {
  const { fiscalYear, month } = period;

  // 1. Fetch budget for the property/year
  const budgets = await BudgetService.filter({
    property_id: propertyId,
    fiscal_year: fiscalYear,
  });
  const budget = budgets[0];

  // 2. Fetch actual expenses
  const filterCriteria = { property_id: propertyId, fiscal_year: fiscalYear };
  if (month) filterCriteria.month = month;
  const actuals = await ExpenseService.filter(filterCriteria);

  // 3. Calculate totals
  const budgetTotal = budget?.total_amount || 0;
  const actualTotal = actuals.reduce((sum, e) => sum + (e.amount || 0), 0);
  const variance = actualTotal - budgetTotal;
  const variancePct = budgetTotal > 0 ? (variance / budgetTotal) * 100 : 0;

  // 4. Category-level comparison
  const budgetLineItems = budget?.line_items ? JSON.parse(budget.line_items) : [];
  const actualsByCategory = {};
  actuals.forEach(e => {
    const cat = e.category || 'other';
    actualsByCategory[cat] = (actualsByCategory[cat] || 0) + (e.amount || 0);
  });

  const categoryComparison = budgetLineItems.map(item => {
    const actualAmt = actualsByCategory[item.category] || 0;
    return {
      category: item.category,
      budgeted: item.amount || 0,
      actual: actualAmt,
      variance: actualAmt - (item.amount || 0),
      variancePct: (item.amount || 0) > 0
        ? ((actualAmt - (item.amount || 0)) / (item.amount || 0)) * 100
        : 0,
    };
  });

  // 5. Build report
  const report = {
    propertyId,
    fiscalYear,
    month: month || null,
    budgetTotal,
    actualTotal,
    variance,
    variancePct: parseFloat(variancePct.toFixed(2)),
    categoryComparison,
    status: Math.abs(variancePct) < 5 ? 'within_threshold' : 'needs_review',
    generatedAt: new Date().toISOString(),
  };

  // 6. Persist
  const saved = await ReconciliationService.create({
    property_id: propertyId,
    fiscal_year: fiscalYear,
    month: month || null,
    budget_total: budgetTotal,
    actual_total: actualTotal,
    variance: variance,
    variance_pct: report.variancePct,
    category_details: JSON.stringify(categoryComparison),
    status: report.status,
  });

  return { report, saved };
}
