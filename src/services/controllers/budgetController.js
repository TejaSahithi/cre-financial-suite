/**
 * Budget Controller — Orchestrates Budget Generation
 *
 * Fetches historical data, delegates to the Budget domain engine,
 * and persists the results.
 */

import { ExpenseService, BudgetService, LeaseService, PropertyService } from '@/services/api';
import { generateBudget, calculateVariance } from '@/services/budgetEngine';

/**
 * Generate a budget projection for a property and fiscal year.
 *
 * @param {string} propertyId
 * @param {number} fiscalYear
 * @param {object} [options] - { inflationRate, lookbackYears }
 * @returns {Promise<{ projection: object, saved: object }>}
 */
export async function generateBudgetForProperty(propertyId, fiscalYear, options = {}) {
  // 1. Fetch prior-year expenses
  const priorYearExpenses = await ExpenseService.filter({
    property_id: propertyId,
    fiscal_year: fiscalYear - 1,
  });

  // 2. Fetch active leases for revenue calculation
  const allLeases = await LeaseService.filter({ property_id: propertyId });
  const activeLeases = allLeases.filter(l => l.status === 'active');

  // 3. Fetch property metadata
  const properties = await PropertyService.filter({ id: propertyId });
  const property = properties[0] || {};

  // 4. Run domain engine
  const budget = generateBudget({
    propertyId,
    year: fiscalYear,
    leases: activeLeases,
    expenses: priorYearExpenses,
    adjustments: {
      inflationPct: options.inflationRate || 3,
      vacancyPct: options.vacancyPct || 5,
    },
  });

  // 5. Persist
  const saved = await BudgetService.create({
    property_id: propertyId,
    fiscal_year: fiscalYear,
    name: `${property.name || 'Property'} — FY${fiscalYear} Budget`,
    total_amount: budget.noi,
    total_expenses: budget.total_expenses,
    gross_rental_income: budget.grossRentalIncome,
    effective_gross_income: budget.effectiveGrossIncome,
    line_items: JSON.stringify(budget.lineItems || []),
    assumptions: JSON.stringify(budget.assumptions || {}),
    status: 'draft',
    created_at: new Date().toISOString(),
  });

  return { budget, saved };
}

/**
 * Compare a budget against actuals to produce variance analysis.
 *
 * @param {string} budgetId
 * @returns {Promise<{ variance: object }>}
 */
export async function compareBudgetToActuals(budgetId) {
  // 1. Fetch budget
  const budgets = await BudgetService.filter({ id: budgetId });
  const budget = budgets[0];
  if (!budget) throw new Error(`Budget ${budgetId} not found`);

  // 2. Fetch actual expenses for same property/year
  const actuals = await ExpenseService.filter({
    property_id: budget.property_id,
    fiscal_year: budget.fiscal_year,
  });

  // 3. Run domain engine
  const variance = calculateVariance(budget, actuals);

  return { variance };
}
