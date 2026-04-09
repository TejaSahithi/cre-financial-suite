/**
 * Lease Controller — Orchestrates Lease Operations
 *
 * Handles lease upload processing, validation, and rent projections
 * by delegating to the Lease domain engine.
 */

import { LeaseService, RentProjectionService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { projectRent } from '@/services/leaseEngine';

/**
 * Process an uploaded lease file: extract data via Vertex AI edge function, validate, and persist.
 *
 * @param {File} file - The uploaded lease PDF/document
 * @param {string} propertyId - Property to associate the lease with
 * @returns {Promise<{ lease: object, extracted: object }>}
 */
export async function processLeaseUpload(file, propertyId) {
  // 1. Upload to Supabase Storage
  const fileName = `leases/${Date.now()}-${file.name}`;
  let fileUrl = '';
  try {
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('financial-uploads')
      .upload(fileName, file, { upsert: true });
    if (!uploadError && uploadData) {
      const { data: urlData } = supabase.storage.from('financial-uploads').getPublicUrl(fileName);
      fileUrl = urlData?.publicUrl || '';
    }
  } catch {
    // Storage unavailable
  }

  // 2. Extract structured data via Vertex AI edge function
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const { data: extracted, error } = await supabase.functions.invoke('extract-lease', {
    body: { file_url: fileUrl, file_name: file.name },
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });

  if (error || !extracted) {
    return { lease: null, extracted: {}, errors: ['Extraction failed'] };
  }

  // 3. Validate minimum required fields
  const errors = [];
  if (!extracted.tenant_name) errors.push('Missing tenant name');
  if (!extracted.start_date) errors.push('Missing start date');
  if (!extracted.base_rent && extracted.base_rent !== 0 && !extracted.annual_rent) errors.push('Missing rent amount');

  if (errors.length > 0) {
    return { lease: null, extracted, errors };
  }

  const monthlyRent = extracted.base_rent || (extracted.annual_rent ? Math.round(extracted.annual_rent / 12) : 0);

  // 4. Persist the lease
  const lease = await LeaseService.create({
    property_id: propertyId,
    tenant_name: extracted.tenant_name,
    start_date: extracted.start_date,
    end_date: extracted.end_date,
    monthly_rent: monthlyRent,
    square_footage: extracted.total_sf || 0,
    annual_rent: extracted.annual_rent || null,
    rent_per_sf: extracted.rent_per_sf || null,
    lease_term_months: extracted.lease_term_months || null,
    lease_type: extracted.lease_type || 'gross',
    escalation_rate: extracted.escalation_value || extracted.escalation_rate || 0,
    escalation_type: extracted.escalation_type || null,
    escalation_timing: extracted.escalation_timing || null,
    free_rent_months: extracted.free_rent_months || null,
    ti_allowance: extracted.ti_allowance || null,
    renewal_options: extracted.renewal_options || null,
    renewal_notice_months: extracted.renewal_notice_months || null,
    cam_applicable: extracted.cam_applicable ?? null,
    cam_cap: extracted.cam_cap ?? null,
    cam_cap_type: extracted.cam_cap_type || null,
    cam_cap_rate: extracted.cam_cap_rate ?? null,
    admin_fee_pct: extracted.admin_fee_pct ?? null,
    gross_up_clause: extracted.gross_up_clause ?? null,
    hvac_responsibility: extracted.hvac_responsibility || null,
    extraction_data: extracted,
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
