/**
 * Budget Engine Service — Production-Ready
 *
 * Domain logic for budget generation, variance analysis, and approval.
 */

// ─── Constants ─────────────────────────────────────────────────────────
export const BUDGET_STATUS = {
  DRAFT: 'draft',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  LOCKED: 'locked',
  REJECTED: 'rejected',
};

export const LINE_ITEM_TYPES = {
  REVENUE: 'revenue',
  EXPENSE: 'expense',
};

// ─── Budget Generation ─────────────────────────────────────────────────

/**
 * Generate a budget from leases, expenses, and prior-year data.
 *
 * @param {object} params
 * @param {string} params.propertyId
 * @param {number} params.year - Budget fiscal year
 * @param {Array}  params.leases - Active leases
 * @param {Array}  params.expenses - Prior-year expenses
 * @param {Array}  [params.priorBudgets] - Previous budgets for trending
 * @param {object} [params.adjustments] - { inflationPct, vacancyPct }
 * @returns {object} Generated budget object
 */
export function generateBudget(params) {
  const {
    propertyId,
    year,
    leases = [],
    expenses = [],
    priorBudgets = [],
    adjustments = {},
  } = params;

  const inflationPct = adjustments.inflationPct || 3; // default 3%
  const vacancyPct = adjustments.vacancyPct || 5;     // default 5%

  // Revenue: annualize all lease rents
  const grossRentalIncome = leases.reduce(
    (sum, l) => sum + ((l.monthly_rent || 0) * 12),
    0
  );
  const vacancyAllowance = grossRentalIncome * (vacancyPct / 100);
  const effectiveGrossIncome = grossRentalIncome - vacancyAllowance;

  // Expenses: inflate prior-year actuals
  const inflationFactor = 1 + inflationPct / 100;

  const expenseCategories = {};
  expenses.forEach(e => {
    const cat = e.category || 'other';
    expenseCategories[cat] = (expenseCategories[cat] || 0) + (e.amount || 0);
  });

  const lineItems = Object.entries(expenseCategories).map(([category, amount]) => ({
    category,
    type: LINE_ITEM_TYPES.EXPENSE,
    priorYear: amount,
    budgeted: parseFloat((amount * inflationFactor).toFixed(2)),
  }));

  const totalExpenses = lineItems.reduce((s, li) => s + li.budgeted, 0);
  const noi = effectiveGrossIncome - totalExpenses;

  return {
    propertyId,
    budget_year: year,
    status: BUDGET_STATUS.DRAFT,
    grossRentalIncome: parseFloat(grossRentalIncome.toFixed(2)),
    vacancyAllowance: parseFloat(vacancyAllowance.toFixed(2)),
    effectiveGrossIncome: parseFloat(effectiveGrossIncome.toFixed(2)),
    total_expenses: parseFloat(totalExpenses.toFixed(2)),
    noi: parseFloat(noi.toFixed(2)),
    lineItems,
    leaseCount: leases.length,
    assumptions: { inflationPct, vacancyPct },
  };
}

// ─── Variance Analysis ─────────────────────────────────────────────────

/**
 * Calculate budget-vs-actual variance.
 *
 * @param {object}  budget   - Budget record with total_expenses
 * @param {Array}   actuals  - Array of actual expense records
 * @returns {object} Variance result
 */
export function calculateVariance(budget, actuals = []) {
  const budgetedTotal = budget?.total_expenses || 0;
  const actualTotal = actuals.reduce((s, a) => s + (a.amount || 0), 0);
  const variance = actualTotal - budgetedTotal;
  const variancePct = budgetedTotal > 0
    ? parseFloat(((variance / budgetedTotal) * 100).toFixed(2))
    : 0;

  // Category-level variance
  const categoryVariance = {};
  actuals.forEach(a => {
    const cat = a.category || 'other';
    if (!categoryVariance[cat]) {
      categoryVariance[cat] = { actual: 0, budgeted: 0 };
    }
    categoryVariance[cat].actual += a.amount || 0;
  });

  // Match against budget line items
  if (budget?.lineItems) {
    budget.lineItems.forEach(li => {
      const cat = li.category || 'other';
      if (!categoryVariance[cat]) {
        categoryVariance[cat] = { actual: 0, budgeted: 0 };
      }
      categoryVariance[cat].budgeted += li.budgeted || 0;
    });
  }

  for (const cat of Object.keys(categoryVariance)) {
    const cv = categoryVariance[cat];
    cv.variance = cv.actual - cv.budgeted;
    cv.variancePct = cv.budgeted > 0
      ? parseFloat(((cv.variance / cv.budgeted) * 100).toFixed(2))
      : 0;
  }

  return {
    budgetedTotal,
    actualTotal: parseFloat(actualTotal.toFixed(2)),
    variance: parseFloat(variance.toFixed(2)),
    variancePct,
    isOverBudget: variance > 0,
    severity: Math.abs(variancePct) > 20 ? 'high' : Math.abs(variancePct) > 10 ? 'medium' : 'low',
    categoryVariance,
  };
}

// ─── Validation ────────────────────────────────────────────────────────

/**
 * Validate a budget for approval readiness.
 * @param {object} budget
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateBudget(budget) {
  const errors = [];
  const warnings = [];

  if (!budget) {
    errors.push('No budget data provided');
    return { valid: false, errors, warnings };
  }
  if (!budget.budget_year) errors.push('Missing budget year');
  if (!budget.propertyId && !budget.property_id) errors.push('Missing property assignment');
  if ((budget.total_expenses || 0) <= 0) warnings.push('Total expenses is zero');
  if ((budget.lineItems || []).length === 0) warnings.push('No line items defined');
  if (budget.status === BUDGET_STATUS.LOCKED) {
    errors.push('Budget is locked and cannot be modified');
  }

  return { valid: errors.length === 0, errors, warnings };
}
