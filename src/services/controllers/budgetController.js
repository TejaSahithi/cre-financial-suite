/**
 * Budget Controller — Orchestrates Budget Generation
 *
 * Fetches historical data, delegates to the Budget domain engine,
 * and persists the results.
 */

import { ExpenseService, BudgetService, PropertyService } from '@/services/api';
import { generateBudgetProjection, analyzeBudgetVariance } from '@/services/budgetEngine';

/**
 * Generate a budget projection for a property and fiscal year.
 *
 * @param {string} propertyId
 * @param {number} fiscalYear
 * @param {object} [options] - { inflationRate, lookbackYears }
 * @returns {Promise<{ projection: object, saved: object }>}
 */
export async function generateBudget(propertyId, fiscalYear, options = {}) {
  // 1. Fetch historical expenses (previous 2 years by default)
  const lookbackYears = options.lookbackYears || 2;
  const historicalExpenses = [];

  for (let yr = fiscalYear - lookbackYears; yr < fiscalYear; yr++) {
    const yearExpenses = await ExpenseService.filter({
      property_id: propertyId,
      fiscal_year: yr,
    });
    historicalExpenses.push(...yearExpenses);
  }

  // 2. Fetch property metadata
  const properties = await PropertyService.filter({ id: propertyId });
  const property = properties[0] || {};

  // 3. Run domain engine
  const projection = generateBudgetProjection({
    historicalExpenses,
    propertyMeta: property,
    targetYear: fiscalYear,
    inflationRate: options.inflationRate,
  });

  // 4. Persist
  const saved = await BudgetService.create({
    property_id: propertyId,
    fiscal_year: fiscalYear,
    name: `${property.name || 'Property'} — FY${fiscalYear} Budget`,
    total_amount: projection.totalProjected,
    line_items: JSON.stringify(projection.lineItems || []),
    assumptions: JSON.stringify(projection.assumptions || {}),
    status: 'draft',
    created_at: new Date().toISOString(),
  });

  return { projection, saved };
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
  const variance = analyzeBudgetVariance({
    budget,
    actuals,
  });

  return { variance };
}
