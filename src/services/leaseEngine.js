/**
 * Lease Engine Service — Production-Ready
 *
 * Domain logic for lease management, validation, and projections.
 */

// ─── Constants ─────────────────────────────────────────────────────────
export const LEASE_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  VALIDATED: 'validated',
  BUDGET_READY: 'budget_ready',
  ACTIVE: 'active',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
  TERMINATED: 'terminated',
};

export const LEASE_TYPES = {
  GROSS: 'gross',
  NET: 'net',
  TRIPLE_NET: 'triple_net',
  MODIFIED_GROSS: 'modified_gross',
  PERCENTAGE: 'percentage',
};

// ─── Validation ────────────────────────────────────────────────────────

/**
 * Validate lease data for completeness and consistency.
 * @param {object} lease
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateLease(lease) {
  const errors = [];
  const warnings = [];

  if (!lease) {
    errors.push('No lease data provided');
    return { valid: false, errors, warnings };
  }

  // Required fields
  if (!lease.tenant_name) errors.push('Missing tenant name');
  if (!lease.start_date) errors.push('Missing lease start date');
  if (!lease.end_date) errors.push('Missing lease end date');

  // Date consistency
  if (lease.start_date && lease.end_date) {
    const start = new Date(lease.start_date);
    const end = new Date(lease.end_date);
    if (end <= start) {
      errors.push('End date must be after start date');
    }
    // Warn if lease is very short or very long
    const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
    if (months < 6) warnings.push('Lease term is less than 6 months');
    if (months > 120) warnings.push('Lease term exceeds 10 years');
  }

  // Financial fields
  if (!lease.monthly_rent || lease.monthly_rent <= 0) {
    errors.push('Monthly rent must be greater than zero');
  }
  if (!lease.square_footage || lease.square_footage <= 0) {
    warnings.push('Missing or zero square footage');
  }

  // Property assignment
  if (!lease.property_id) warnings.push('No property assigned');

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Lease Status Determination ────────────────────────────────────────

/**
 * Determine the effective status of a lease based on dates.
 * @param {object} lease
 * @param {number} [expiryWarningDays=180]
 * @returns {string} Effective status
 */
export function determineLeaseStatus(lease, expiryWarningDays = 180) {
  if (!lease.start_date || !lease.end_date) return lease.status || LEASE_STATUS.DRAFT;

  const now = new Date();
  const start = new Date(lease.start_date);
  const end = new Date(lease.end_date);

  if (now < start) return LEASE_STATUS.DRAFT;
  if (now > end) return LEASE_STATUS.EXPIRED;

  const daysLeft = Math.floor((end - now) / (1000 * 60 * 60 * 24));
  if (daysLeft <= expiryWarningDays) return LEASE_STATUS.EXPIRING;

  return lease.status || LEASE_STATUS.ACTIVE;
}

// ─── Rent Projections ──────────────────────────────────────────────────

/**
 * Project rent over the lease term with optional annual escalation.
 * @param {object} lease
 * @param {object} [options] - { escalationPct, projectionMonths }
 * @returns {object} Projection result
 */
export function projectRent(lease, options = {}) {
  const escalationPct = options.escalationPct || 0;
  const monthlyRent = lease.monthly_rent || 0;

  if (!lease.start_date || !lease.end_date) {
    return {
      leaseId: lease.id,
      tenantName: lease.tenant_name,
      monthlyRent,
      annualRent: monthlyRent * 12,
      projections: [],
    };
  }

  const start = new Date(lease.start_date);
  const end = new Date(lease.end_date);
  const projections = [];
  let currentRent = monthlyRent;
  let year = start.getFullYear();
  const endYear = end.getFullYear();

  while (year <= endYear) {
    const annualRent = currentRent * 12;
    projections.push({
      year,
      monthlyRent: parseFloat(currentRent.toFixed(2)),
      annualRent: parseFloat(annualRent.toFixed(2)),
    });
    year++;
    currentRent *= (1 + escalationPct / 100);
  }

  const totalProjected = projections.reduce((s, p) => s + p.annualRent, 0);

  return {
    leaseId: lease.id,
    tenantName: lease.tenant_name,
    monthlyRent,
    annualRent: monthlyRent * 12,
    escalationPct,
    totalProjected: parseFloat(totalProjected.toFixed(2)),
    projections,
  };
}

// ─── LLM Lease Parsing ─────────────────────────────────────────────────

/**
 * Parse extracted lease data from LLM output.
 * Validates and normalises the extracted fields.
 * @param {string} rawText - Raw JSON string from LLM
 * @returns {object} Parsed and normalised lease data
 */
export function parseExtractedLease(rawText) {
  try {
    const data = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;

    // Normalise common field variations
    return {
      tenant_name: data.tenant_name || data.tenantName || data.tenant || '',
      start_date: data.start_date || data.startDate || data.commencement_date || '',
      end_date: data.end_date || data.endDate || data.expiration_date || '',
      monthly_rent: parseFloat(data.monthly_rent || data.monthlyRent || data.base_rent || 0),
      square_footage: parseFloat(data.square_footage || data.sqft || data.area || 0),
      lease_type: data.lease_type || data.leaseType || LEASE_TYPES.GROSS,
      property_id: data.property_id || data.propertyId || '',
      unit_id: data.unit_id || data.unitId || '',
      ...data, // preserve any extra fields
    };
  } catch (err) {
    console.error('[leaseEngine] parseExtractedLease() error:', err);
    return {};
  }
}

/**
 * Calculate remaining days on a lease.
 * @param {object} lease
 * @returns {number|null} Days remaining, or null if dates missing
 */
export function daysRemaining(lease) {
  if (!lease.end_date) return null;
  const end = new Date(lease.end_date);
  const now = new Date();
  return Math.max(0, Math.floor((end - now) / (1000 * 60 * 60 * 24)));
}
