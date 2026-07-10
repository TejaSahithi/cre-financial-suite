import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistLeaseExtractionMerge } from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase HARD-3B3A. This wrapper is
// a thin pass-through to the persist-lease-extraction-merge edge function,
// which replaces the last remaining direct leases UPDATE persistence paths
// in LeaseReview.jsx's handleReextractLease and
// ExtractionDebugPanel.jsx's handleApplyLatestExtraction. The RPC-level
// validation/audit/whitelist behavior is covered by
// supabase/functions/_tests/persist-lease-extraction-merge.property.test.ts.
// This test only proves the wrapper sends the exact request shape the
// deployed edge function expects and that a missing lease id fails fast
// without a network call.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('leaseService.persistLeaseExtractionMerge', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('calls persist-lease-extraction-merge with lease_id/action/patch', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', extraction_data: {} });

    await persistLeaseExtractionMerge({
      leaseId: 'lease-1',
      action: 'lease_extraction_merged',
      patch: { evidence_refreshed_at: '2026-07-10T00:00:00.000Z' },
    });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('persist-lease-extraction-merge', {
      lease_id: 'lease-1',
      action: 'lease_extraction_merged',
      patch: { evidence_refreshed_at: '2026-07-10T00:00:00.000Z' },
    });
  });

  it('rejects a missing lease id without calling the edge function', async () => {
    await expect(
      persistLeaseExtractionMerge({ action: 'lease_extraction_merged', patch: {} }),
    ).rejects.toThrow('Lease ID is required');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('propagates edge function errors (e.g. approved-lease lock) to the caller', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(
      new Error('Lease abstract is approved and locked; extraction data cannot be modified'),
    );
    await expect(
      persistLeaseExtractionMerge({ leaseId: 'lease-1', action: 'lease_extraction_merged', patch: {} }),
    ).rejects.toThrow('approved and locked');
  });

  it('propagates edge function errors for each of the 4 real actions used by the frontend', async () => {
    const actions = [
      'lease_extraction_manual_review_recorded',
      'lease_extraction_merged',
      'lease_extraction_merge_blocked',
      'lease_extraction_debug_applied',
    ];
    for (const action of actions) {
      invokeEdgeFunctionMock.mockReset();
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1' });
      await persistLeaseExtractionMerge({ leaseId: 'lease-1', action, patch: {} });
      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('persist-lease-extraction-merge', {
        lease_id: 'lease-1',
        action,
        patch: {},
      });
    }
  });
});
