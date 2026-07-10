import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  updateLeaseExtractionField,
  saveLeaseReviewDraftWorkflow,
  rejectLeaseAbstractWorkflow,
  sendLeaseBackForReextraction,
} from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase HARD-3B1. These four
// wrappers are thin pass-throughs to already-deployed edge functions
// (update-lease-extraction-field, save-lease-review-draft,
// reject-lease-abstract, send-lease-back-for-reextraction) -- the RPC-level
// validation/audit/RLS behavior is covered by the corresponding Deno
// property tests in supabase/functions/_tests/. These tests prove each
// wrapper sends the exact request shape the deployed edge function expects
// (lease_id/field_area/action/field_key/patch, lease_id/field_reviews,
// lease_id/reason/rejected_by, lease_id/reason) and that a missing lease id
// fails fast without a network call.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('leaseService HARD-3B1 workflow wrappers', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  describe('updateLeaseExtractionField', () => {
    it('calls update-lease-extraction-field with the field_value shape', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', extraction_data: {} });

      await updateLeaseExtractionField({
        leaseId: 'lease-1',
        fieldArea: 'field_value',
        action: 'field_evidence_edit',
        fieldKey: 'tenant_name',
        patch: { field: { value: 'Acme' }, field_evidence: { source_text: 'p.1' } },
      });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('update-lease-extraction-field', {
        lease_id: 'lease-1',
        field_area: 'field_value',
        action: 'field_evidence_edit',
        field_key: 'tenant_name',
        patch: { field: { value: 'Acme' }, field_evidence: { source_text: 'p.1' } },
      });
    });

    it('calls update-lease-extraction-field with the source_link shape and null field_key', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', extraction_data: {} });

      await updateLeaseExtractionField({
        leaseId: 'lease-1',
        fieldArea: 'source_link',
        action: 'source_file_manually_linked',
        patch: { source_file_id: 'file-1' },
      });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('update-lease-extraction-field', {
        lease_id: 'lease-1',
        field_area: 'source_link',
        action: 'source_file_manually_linked',
        field_key: null,
        patch: { source_file_id: 'file-1' },
      });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(
        updateLeaseExtractionField({ fieldArea: 'source_link', action: 'source_file_manually_linked', patch: {} }),
      ).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });

    it('propagates edge function errors (e.g. approved-lease lock) to the caller', async () => {
      invokeEdgeFunctionMock.mockRejectedValue(
        new Error('Lease abstract is approved and locked; extraction_data cannot be modified'),
      );
      await expect(
        updateLeaseExtractionField({
          leaseId: 'lease-1',
          fieldArea: 'lease_flag',
          action: 'document_type_override_set',
          patch: { document_type_override: 'full_lease' },
        }),
      ).rejects.toThrow('approved and locked');
    });
  });

  describe('saveLeaseReviewDraftWorkflow', () => {
    it('calls save-lease-review-draft with lease_id and field_reviews', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', abstract_status: 'pending_review' });

      await saveLeaseReviewDraftWorkflow({ leaseId: 'lease-1', fieldReviews: { tenant_name: { status: 'accepted' } } });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('save-lease-review-draft', {
        lease_id: 'lease-1',
        field_reviews: { tenant_name: { status: 'accepted' } },
      });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(saveLeaseReviewDraftWorkflow({ fieldReviews: {} })).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });
  });

  describe('rejectLeaseAbstractWorkflow', () => {
    it('calls reject-lease-abstract with lease_id, reason, and rejected_by', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', status: 'rejected' });

      await rejectLeaseAbstractWorkflow({ leaseId: 'lease-1', reason: 'Missing signature page', rejectedBy: 'Jane Doe' });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('reject-lease-abstract', {
        lease_id: 'lease-1',
        reason: 'Missing signature page',
        rejected_by: 'Jane Doe',
      });
    });

    it('defaults rejected_by to null when omitted', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', status: 'rejected' });
      await rejectLeaseAbstractWorkflow({ leaseId: 'lease-1', reason: 'bad doc' });
      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('reject-lease-abstract', {
        lease_id: 'lease-1',
        reason: 'bad doc',
        rejected_by: null,
      });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(rejectLeaseAbstractWorkflow({ reason: 'x' })).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });
  });

  describe('sendLeaseBackForReextraction', () => {
    it('calls send-lease-back-for-reextraction with lease_id and reason', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', status: 'draft' });

      await sendLeaseBackForReextraction({ leaseId: 'lease-1', reason: 'Blurry scan' });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('send-lease-back-for-reextraction', {
        lease_id: 'lease-1',
        reason: 'Blurry scan',
      });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(sendLeaseBackForReextraction({ reason: 'x' })).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });
  });
});
