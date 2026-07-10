import { describe, it, expect, vi, beforeEach } from 'vitest';
import { linkLeaseSpaceAssignment } from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase 6R-13 (link_lease_space_assignment).
// This wrapper is a thin pass-through to the edge function -- the real
// validation/idempotency/audit behavior is covered by
// supabase/functions/_tests/link-lease-space-assignment.property.test.ts.
// This test only proves the frontend call site sends the right shape and no
// longer performs any direct supabase.from("leases") write itself.
const invokeEdgeFunctionMock = vi.fn().mockResolvedValue({ lease_id: 'lease-1', building_id: 'b-1', unit_id: 'u-1', changed: true });

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('leaseService.linkLeaseSpaceAssignment', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockClear();
  });

  it('calls the link-lease-space-assignment edge function with building_id and unit_id', async () => {
    const result = await linkLeaseSpaceAssignment({ leaseId: 'lease-1', buildingId: 'b-1', unitId: 'u-1' });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('link-lease-space-assignment', {
      lease_id: 'lease-1',
      building_id: 'b-1',
      unit_id: 'u-1',
    });
    expect(result.changed).toBe(true);
  });

  it('defaults building_id/unit_id to null when only one is resolved', async () => {
    await linkLeaseSpaceAssignment({ leaseId: 'lease-2', unitId: 'u-2' });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('link-lease-space-assignment', {
      lease_id: 'lease-2',
      building_id: null,
      unit_id: 'u-2',
    });
  });
});
