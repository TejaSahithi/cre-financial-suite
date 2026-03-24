/**
 * CAM Controller — Orchestrates CAM Calculations
 *
 * Fetches required data, delegates to the CAM domain engine,
 * and persists the results. No business logic lives here.
 */

import { ExpenseService, LeaseService, CAMCalculationService } from '@/services/api';
import { calculateCAM, validateCAMCalculation } from '@/services/camEngine';

/**
 * Run a full CAM calculation for a property and fiscal year.
 *
 * @param {string} propertyId - Property ID
 * @param {number} fiscalYear - Fiscal year (e.g. 2026)
 * @param {object} [rules] - Optional CAM rules override { method, capAmount, adminFeePct }
 * @returns {Promise<{ calculation: object, validation: object, saved: object }>}
 */
export async function runCAMCalculation(propertyId, fiscalYear, rules = {}) {
  // 1. Fetch expenses for the property/year
  const expenses = await ExpenseService.filter({
    property_id: propertyId,
    fiscal_year: fiscalYear,
  });

  // 2. Fetch active leases for the property
  const allLeases = await LeaseService.filter({ property_id: propertyId });
  const activeLeases = allLeases.filter(l => l.status === 'active');

  // 3. Run domain engine
  const calculation = calculateCAM({ expenses, leases: activeLeases, rules });

  // 4. Validate
  const validation = validateCAMCalculation(calculation);

  // 5. Persist the result
  const saved = await CAMCalculationService.create({
    property_id: propertyId,
    fiscal_year: fiscalYear,
    method: calculation.method,
    total_recoverable: calculation.totalRecoverable,
    admin_fee: calculation.adminFee,
    cam_pool: calculation.camPool,
    total_area: calculation.totalArea,
    rate_per_sqft: calculation.ratePerSqFt,
    total_allocated: calculation.totalAllocated,
    tenant_shares: JSON.stringify(calculation.tenantShares),
    category_breakdown: JSON.stringify(calculation.categoryBreakdown),
    status: validation.valid ? 'completed' : 'needs_review',
    calculated_at: new Date().toISOString(),
  });

  return { calculation, validation, saved };
}
