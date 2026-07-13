import { describe, it, expect, vi, beforeEach } from 'vitest';
import { leaseService } from '@/services/leaseService';

// Frontend lease deletion must route directly through the server-owned
// delete-lease-cascade Edge Function. The Edge Function owns auth, org
// ownership, cascade validation, and any RPC details. The browser must not
// preflight with baseService.get(), call supabase.rpc(), or fall back to
// direct table deletes.
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
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123', email: 'test@example.com' } }, error: null }),
    },
  },
}));

describe('leaseService.delete', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
    fromMock.mockReset();
    rpcMock.mockReset();
  });

  it('returns true when delete-lease-cascade succeeds', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, lease_id: 'lease-1' });

    const result = await leaseService.delete('lease-1');

    expect(result).toBe(true);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-lease-cascade', { lease_id: 'lease-1' });
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('propagates unavailable-workflow errors from the Edge Function unchanged', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(
      new Error('Lease deletion is temporarily unavailable because the server-side delete workflow is not deployed. Please contact support or retry after migrations are applied.'),
    );

    await expect(leaseService.delete('lease-2')).rejects.toThrow(
      'Lease deletion is temporarily unavailable because the server-side delete workflow is not deployed. Please contact support or retry after migrations are applied.',
    );
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('passes through Lease not found unchanged', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('Lease not found'));

    await expect(leaseService.delete('lease-3c')).rejects.toThrow('Lease not found');
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('throws the original business/runtime Edge Function error directly', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('update or delete on table "leases" violates foreign key constraint'));

    await expect(leaseService.delete('lease-4')).rejects.toThrow('violates foreign key constraint');
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('throws permission-denied Edge Function errors directly', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('permission denied for function delete_lease_cascade'));

    await expect(leaseService.delete('lease-5')).rejects.toThrow('permission denied');
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('requires a lease id', async () => {
    await expect(leaseService.delete(null)).rejects.toThrow('Lease ID is required for deletion');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
