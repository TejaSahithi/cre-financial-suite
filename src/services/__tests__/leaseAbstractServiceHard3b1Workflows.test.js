import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveAbstractDraft, rejectLeaseAbstract } from '@/services/leaseAbstractService';

// Feature: enterprise-readiness-hardening Phase HARD-3B1. saveAbstractDraft
// and rejectLeaseAbstract now route through the already-deployed
// save_lease_review_draft / reject_lease_abstract RPCs (via
// saveLeaseReviewDraftWorkflow / rejectLeaseAbstractWorkflow in
// leaseService.js) instead of writing extraction_data/status/abstract_status
// directly. The RPC-level validation/audit/lock behavior is covered by
// supabase/functions/_tests/save-lease-review-draft.property.test.ts and
// reject-lease-abstract.property.test.ts. These tests prove: (1) the correct
// wrapper is called with the correct shape, (2) no direct
// supabase.from("leases").update() happens (the mocked supabase client's
// .update is never invoked), and (3) the returned object still carries the
// fields callers depend on (property_id for handleSaveDraft's compute
// trigger, status/abstract_status/extraction_data for
// updateLeaseQueryCache(...rejectedLease) in handleRejectDocument).
const { saveLeaseReviewDraftWorkflowMock, rejectLeaseAbstractWorkflowMock, supabaseUpdateMock } = vi.hoisted(() => ({
  saveLeaseReviewDraftWorkflowMock: vi.fn(),
  rejectLeaseAbstractWorkflowMock: vi.fn(),
  supabaseUpdateMock: vi.fn(),
}));

vi.mock('@/services/leaseService', () => ({
  saveLeaseReviewDraftWorkflow: (...args) => saveLeaseReviewDraftWorkflowMock(...args),
  rejectLeaseAbstractWorkflow: (...args) => rejectLeaseAbstractWorkflowMock(...args),
}));

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (...args) => {
        supabaseUpdateMock(...args);
        return {
          eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
        };
      },
      upsert: () => ({ select: async () => ({ data: [], error: null }) }),
    }),
  },
}));

describe('leaseAbstractService HARD-3B1 workflow conversions', () => {
  beforeEach(() => {
    saveLeaseReviewDraftWorkflowMock.mockReset();
    rejectLeaseAbstractWorkflowMock.mockReset();
    supabaseUpdateMock.mockReset();
  });

  describe('saveAbstractDraft', () => {
    it('calls saveLeaseReviewDraftWorkflow with lease id and field reviews, no direct leases update', async () => {
      saveLeaseReviewDraftWorkflowMock.mockResolvedValue({
        lease_id: 'lease-1',
        property_id: 'prop-1',
        extraction_data: { field_reviews: { tenant_name: { status: 'accepted' } } },
        abstract_status: 'pending_review',
        updated_at: '2026-07-01T00:00:00Z',
      });

      const lease = { id: 'lease-1', org_id: 'org-1', property_id: 'prop-1', extraction_data: {} };
      const fieldReviews = { tenant_name: { status: 'accepted' } };

      const result = await saveAbstractDraft({ lease, fieldReviews, reviewer: 'Jane Doe' });

      expect(saveLeaseReviewDraftWorkflowMock).toHaveBeenCalledWith({ leaseId: 'lease-1', fieldReviews });
      expect(supabaseUpdateMock).not.toHaveBeenCalled();
      expect(result.property_id).toBe('prop-1');
      expect(result.abstract_status).toBe('pending_review');
    });

    it('falls back to the passed-in lease.property_id when the RPC response omits it', async () => {
      saveLeaseReviewDraftWorkflowMock.mockResolvedValue({ lease_id: 'lease-1', extraction_data: {} });
      const lease = { id: 'lease-1', property_id: 'prop-fallback', extraction_data: {} };

      const result = await saveAbstractDraft({ lease, fieldReviews: {} });

      expect(result.property_id).toBe('prop-fallback');
    });

    it('propagates the approved-lease lock error to the caller (no silent success)', async () => {
      saveLeaseReviewDraftWorkflowMock.mockRejectedValue(
        new Error('Lease abstract is approved and locked; the review draft cannot be modified'),
      );
      const lease = { id: 'lease-1', abstract_status: 'approved', extraction_data: {} };

      await expect(saveAbstractDraft({ lease, fieldReviews: {} })).rejects.toThrow('approved and locked');
      expect(supabaseUpdateMock).not.toHaveBeenCalled();
    });

    it('rejects a lease with no id before calling the workflow', async () => {
      await expect(saveAbstractDraft({ lease: {}, fieldReviews: {} })).rejects.toThrow('lease.id is required');
      expect(saveLeaseReviewDraftWorkflowMock).not.toHaveBeenCalled();
    });
  });

  describe('rejectLeaseAbstract', () => {
    it('calls rejectLeaseAbstractWorkflow with lease id, reason, and rejected_by; no direct leases update', async () => {
      rejectLeaseAbstractWorkflowMock.mockResolvedValue({
        lease_id: 'lease-1',
        property_id: 'prop-1',
        status: 'rejected',
        abstract_status: 'rejected',
        extraction_data: { rejection: { reason: 'Missing signature page' } },
        updated_at: '2026-07-01T00:00:00Z',
      });

      const lease = { id: 'lease-1', property_id: 'prop-1', extraction_data: {} };
      const result = await rejectLeaseAbstract({ lease, reason: 'Missing signature page', reviewer: 'Jane Doe' });

      expect(rejectLeaseAbstractWorkflowMock).toHaveBeenCalledWith({
        leaseId: 'lease-1',
        reason: 'Missing signature page',
        rejectedBy: 'Jane Doe',
      });
      expect(supabaseUpdateMock).not.toHaveBeenCalled();
      expect(result.status).toBe('rejected');
      expect(result.abstract_status).toBe('rejected');
    });

    it('rejects a lease with no id before calling the workflow', async () => {
      await expect(rejectLeaseAbstract({ lease: {}, reason: 'x' })).rejects.toThrow('lease.id is required');
      expect(rejectLeaseAbstractWorkflowMock).not.toHaveBeenCalled();
    });
  });
});
