import { describe, it, expect, vi, beforeEach } from 'vitest';
import { leaseService } from '@/services/leaseService';

// Feature: PRE-AZ-HOTFIX-1. leaseService.delete() used to call
// supabase.rpc('delete_lease_cascade', ...) directly from the browser
// (allowed by the RPC's now-revoked anon/authenticated EXECUTE grant), with
// a deleteLeaseCascadeFallback() direct-table-delete fallback if the RPC
// call itself errored. Both are replaced by the server-owned
// delete-lease-cascade edge function. This test proves: (1) delete() now
// routes exclusively through invokeEdgeFunction, (2) a missing lease id
// fails fast without a network call, (3) an edge function failure
// propagates to the caller rather than silently falling back to a direct
// table delete, (4) no direct supabase.rpc/from call is made by this
// module at all.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

const fromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    from: (...args) => fromMock(...args),
    rpc: (...args) => rpcMock(...args),
  },
}));

describe('leaseService.delete', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
    fromMock.mockReset();
    rpcMock.mockReset();
  });

  it('calls delete-lease-cascade with lease_id and returns true on success', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, lease_id: 'lease-1' });

    const result = await leaseService.delete('lease-1');

    expect(result).toBe(true);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-lease-cascade', {
      lease_id: 'lease-1',
    });
  });

  it('rejects a missing lease id without calling the edge function', async () => {
    await expect(leaseService.delete()).rejects.toThrow('Lease ID is required');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('propagates edge function errors to the caller instead of falling back to a direct delete', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('Lease does not belong to your organization'));

    await expect(leaseService.delete('lease-1')).rejects.toThrow('does not belong to your organization');
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('never calls supabase.rpc or supabase.from directly for cascade delete', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, lease_id: 'lease-2' });

    await leaseService.delete('lease-2');

    expect(rpcMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });
});
