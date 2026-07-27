import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  updateLeaseFieldAndColumns,
  backfillLeaseEvidence,
  linkLeaseSpaceAssignment,
} from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase HARD-3B2. These three
// wrappers are thin pass-throughs to their edge functions
// (update-lease-field-and-columns, backfill-lease-evidence -- both new this
// phase -- and link-lease-space-assignment, an already-deployed workflow
// from Phase 6R-13 reused here). The RPC-level validation/audit/whitelist
// behavior is covered by the corresponding Deno property tests in
// supabase/functions/_tests/. These tests prove each wrapper sends the
// exact request shape the deployed edge function expects and that a
// missing lease id fails fast without a network call.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('leaseService HARD-3B2 workflow wrappers', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  describe('updateLeaseFieldAndColumns', () => {
    it('calls update-lease-field-and-columns with lease_id/field_key/column_updates/patch', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', applied_columns: ['monthly_rent'], ignored_columns: [] });

      await updateLeaseFieldAndColumns({
        leaseId: 'lease-1',
        fieldKey: 'monthly_rent',
        columnUpdates: { monthly_rent: 4500 },
        patch: { field: { value: 4500 } },
      });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('update-lease-field-and-columns', {
        lease_id: 'lease-1',
        field_key: 'monthly_rent',
        column_updates: { monthly_rent: 4500 },
        patch: { field: { value: 4500 } },
      }, {}, { page: 'LeaseReview', action: 'field_edit' });
    });

    it('defaults columnUpdates/patch to empty objects when omitted', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1' });
      await updateLeaseFieldAndColumns({ leaseId: 'lease-1', fieldKey: 'tenant_name' });
      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('update-lease-field-and-columns', {
        lease_id: 'lease-1',
        field_key: 'tenant_name',
        column_updates: {},
        patch: {},
      }, {}, { page: 'LeaseReview', action: 'field_edit' });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(updateLeaseFieldAndColumns({ fieldKey: 'x' })).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });

    it('propagates edge function errors (e.g. approved-lease lock) to the caller', async () => {
      invokeEdgeFunctionMock.mockRejectedValue(
        new Error('Lease abstract is approved and locked; this field cannot be modified'),
      );
      await expect(
        updateLeaseFieldAndColumns({ leaseId: 'lease-1', fieldKey: 'monthly_rent', columnUpdates: {}, patch: {} }),
      ).rejects.toThrow('approved and locked');
    });
  });

  describe('backfillLeaseEvidence', () => {
    it('calls backfill-lease-evidence with lease_id/fields_patch/field_evidence_patch/workflow_output', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1' });

      await backfillLeaseEvidence({
        leaseId: 'lease-1',
        fieldsPatch: { tenant_name: { value: 'Acme' } },
        fieldEvidencePatch: { tenant_name: { source_text: 'p.1' } },
        workflowOutput: { lease_fields: {} },
      });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('backfill-lease-evidence', {
        lease_id: 'lease-1',
        fields_patch: { tenant_name: { value: 'Acme' } },
        field_evidence_patch: { tenant_name: { source_text: 'p.1' } },
        workflow_output: { lease_fields: {} },
      }, {}, { page: 'LeaseReview', action: 'evidence_backfill' });
    });

    it('defaults workflowOutput to null and patches to empty objects when omitted', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1' });
      await backfillLeaseEvidence({ leaseId: 'lease-1' });
      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('backfill-lease-evidence', {
        lease_id: 'lease-1',
        fields_patch: {},
        field_evidence_patch: {},
        workflow_output: null,
      }, {}, { page: 'LeaseReview', action: 'evidence_backfill' });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(backfillLeaseEvidence({})).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });
  });

  describe('linkLeaseSpaceAssignment', () => {
    it('calls link-lease-space-assignment with lease_id/building_id/unit_id', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', changed: true });

      await linkLeaseSpaceAssignment({ leaseId: 'lease-1', buildingId: 'building-1', unitId: 'unit-1' });

      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('link-lease-space-assignment', {
        lease_id: 'lease-1',
        building_id: 'building-1',
        unit_id: 'unit-1',
      });
    });

    it('defaults buildingId/unitId to null when omitted', async () => {
      invokeEdgeFunctionMock.mockResolvedValue({ lease_id: 'lease-1', changed: false });
      await linkLeaseSpaceAssignment({ leaseId: 'lease-1' });
      expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('link-lease-space-assignment', {
        lease_id: 'lease-1',
        building_id: null,
        unit_id: null,
      });
    });

    it('rejects a missing lease id without calling the edge function', async () => {
      await expect(linkLeaseSpaceAssignment({ buildingId: 'b' })).rejects.toThrow('Lease ID is required');
      expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    });
  });
});
