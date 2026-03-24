/**
 * CAM Engine Service — Production-Ready
 *
 * Domain logic for Common Area Maintenance calculations.
 * All calculation logic stays here — never in UI components.
 */

// ─── Constants ─────────────────────────────────────────────────────────
export const CAM_CLASSIFICATIONS = {
  RECOVERABLE: 'recoverable',
  NON_RECOVERABLE: 'non_recoverable',
  CONDITIONAL: 'conditional',
};

export const CAM_METHODS = {
  PRO_RATA: 'pro_rata',      // Share based on square footage
  FIXED: 'fixed',            // Fixed amount per lease
  CAPPED: 'capped',          // Pro-rata with annual cap
};

// ─── Core Calculations ─────────────────────────────────────────────────

/**
 * Calculate CAM charges for a property using a pro-rata share method.
 *
 * @param {object} params
 * @param {Array}  params.expenses   - All expenses for the property/year
 * @param {Array}  params.leases     - Active leases with square_footage
 * @param {object} [params.rules]    - { method, capAmount, adminFeePct }
 * @returns {object} CAM calculation result
 */
export function calculateCAM({ expenses = [], leases = [], rules = {} }) {
  const method = rules.method || CAM_METHODS.PRO_RATA;
  const adminFeePct = rules.adminFeePct || 0;
  const capAmount = rules.capAmount || Infinity;

  // 1. Total recoverable operating expenses
  const totalRecoverable = expenses
    .filter(e => e.classification === CAM_CLASSIFICATIONS.RECOVERABLE)
    .reduce((sum, e) => sum + (e.amount || 0), 0);

  // 2. Admin fee
  const adminFee = totalRecoverable * (adminFeePct / 100);

  // 3. Net CAM pool
  const camPool = totalRecoverable + adminFee;

  // 4. Total leasable area
  const totalArea = leases.reduce((sum, l) => sum + (l.square_footage || 0), 0);

  // 5. Rate per square foot
  const ratePerSqFt = totalArea > 0 ? camPool / totalArea : 0;

  // 6. Tenant shares
  const tenantShares = leases.map(lease => {
    const sqft = lease.square_footage || 0;
    const share = totalArea > 0 ? sqft / totalArea : 0;
    let rawAmount = 0;

    switch (method) {
      case CAM_METHODS.PRO_RATA:
        rawAmount = ratePerSqFt * sqft;
        break;
      case CAM_METHODS.FIXED:
        rawAmount = rules.fixedAmount || 0;
        break;
      case CAM_METHODS.CAPPED:
        rawAmount = Math.min(ratePerSqFt * sqft, capAmount);
        break;
      default:
        rawAmount = ratePerSqFt * sqft;
    }

    return {
      leaseId: lease.id,
      tenantName: lease.tenant_name || 'Unknown',
      sqft,
      share: parseFloat(share.toFixed(6)),
      annualAmount: parseFloat(rawAmount.toFixed(2)),
      monthlyAmount: parseFloat((rawAmount / 12).toFixed(2)),
    };
  });

  // 7. Expense breakdown by category
  const categoryBreakdown = {};
  expenses
    .filter(e => e.classification === CAM_CLASSIFICATIONS.RECOVERABLE)
    .forEach(e => {
      const cat = e.category || 'other';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + (e.amount || 0);
    });

  return {
    totalRecoverable,
    adminFee,
    camPool,
    totalArea,
    ratePerSqFt: parseFloat(ratePerSqFt.toFixed(4)),
    method,
    tenantShares,
    categoryBreakdown,
    totalAllocated: tenantShares.reduce((s, t) => s + t.annualAmount, 0),
  };
}

/**
 * Validate a CAM calculation for completeness.
 * @param {object} calculation - Result from calculateCAM
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateCAMCalculation(calculation) {
  const errors = [];
  const warnings = [];

  if (!calculation) {
    errors.push('No calculation data provided');
    return { valid: false, errors, warnings };
  }
  if (calculation.totalArea === 0) {
    errors.push('Total leasable area is zero — no tenants to allocate to');
  }
  if (calculation.totalRecoverable === 0) {
    warnings.push('No recoverable expenses found');
  }
  if (calculation.tenantShares?.length === 0) {
    errors.push('No active leases for CAM allocation');
  }

  // Check shares sum to ~1.0
  const totalShare = (calculation.tenantShares || []).reduce((s, t) => s + t.share, 0);
  if (totalShare > 0 && Math.abs(totalShare - 1.0) > 0.001) {
    warnings.push(`Tenant shares sum to ${totalShare.toFixed(4)}, expected ~1.0`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Compare two CAM calculations (e.g. year-over-year).
 */
export function compareCAM(current, previous) {
  if (!current || !previous) return null;
  return {
    poolChange: current.camPool - previous.camPool,
    poolChangePct: previous.camPool > 0
      ? ((current.camPool - previous.camPool) / previous.camPool) * 100
      : 0,
    rateChange: current.ratePerSqFt - previous.ratePerSqFt,
  };
}
