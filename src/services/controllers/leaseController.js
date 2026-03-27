/**
 * Lease Controller — Orchestrates Lease Operations
 *
 * Handles lease upload processing, validation, and rent projections
 * by delegating to the Lease domain engine.
 */

import { LeaseService, RentProjectionService } from '@/services/api';
import { extractDataFromUploadedFile } from '@/services/integrations';
import { projectRent } from '@/services/leaseEngine';

/**
 * Process an uploaded lease file: extract data, validate, and persist.
 *
 * @param {File} file - The uploaded lease PDF/document
 * @param {string} propertyId - Property to associate the lease with
 * @returns {Promise<{ lease: object, extracted: object }>}
 */
export async function processLeaseUpload(file, propertyId) {
  // 1. Extract structured data from the uploaded file
  const extracted = await extractDataFromUploadedFile({
    file_url: URL.createObjectURL(file),
    json_schema: {
      tenant_name: 'string',
      start_date: 'string',
      end_date: 'string',
      monthly_rent: 'number',
      square_footage: 'number',
      lease_type: 'string',
      escalation_rate: 'number',
    },
  });

  // 2. Validate minimum required fields
  const errors = [];
  if (!extracted.tenant_name) errors.push('Missing tenant name');
  if (!extracted.start_date) errors.push('Missing start date');
  if (!extracted.monthly_rent && extracted.monthly_rent !== 0) errors.push('Missing monthly rent');

  if (errors.length > 0) {
    return { lease: null, extracted, errors };
  }

  // 3. Persist the lease
  const lease = await LeaseService.create({
    property_id: propertyId,
    tenant_name: extracted.tenant_name,
    start_date: extracted.start_date,
    end_date: extracted.end_date,
    monthly_rent: extracted.monthly_rent,
    square_footage: extracted.square_footage || 0,
    lease_type: extracted.lease_type || 'gross',
    escalation_rate: extracted.escalation_rate || 0,
    status: 'active',
    source: 'upload',
  });

  return { lease, extracted, errors: [] };
}

/**
 * Calculate and persist a rent projection for a lease.
 *
 * @param {string} leaseId
 * @returns {Promise<{ projection: object, saved: object }>}
 */
export async function calculateRentProjection(leaseId) {
  // 1. Fetch the lease
  const leases = await LeaseService.filter({ id: leaseId });
  const lease = leases[0];
  if (!lease) throw new Error(`Lease ${leaseId} not found`);

  // 2. Run domain engine — projectRent returns per-year projections and totalProjected
  const projection = projectRent(lease, {
    escalationPct: lease.escalation_rate || 0,
  });

  // 3. Persist projection
  const saved = await RentProjectionService.create({
    lease_id: leaseId,
    property_id: lease.property_id,
    total_revenue: projection.totalProjected,
    monthly_schedule: JSON.stringify(projection.projections),
    start_date: lease.start_date,
    end_date: lease.end_date,
    status: 'calculated',
  });

  return { projection, saved };
}
