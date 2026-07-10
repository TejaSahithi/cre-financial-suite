import { describe, it, expect, vi, beforeEach } from 'vitest';
import { leaseService } from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase 6R-10 (remove
// deleteLeaseCascadeFallback) + Phase 6R-10A (tighten the missing-schema
// classifier so it no longer misfires on the RPC's own "not found"-shaped
// business errors). Properties:
//   1. RPC success path still returns true.
//   2. RPC schema-cache-miss/missing-function error (by code, or by a
//      message that specifically names delete_lease_cascade/schema cache)
//      throws the clear unavailable-workflow error, not a generic one.
//   3. The missing-function path makes zero direct supabase.from(...)
//      delete/update calls (no client-side cascade remains reachable).
//   4. A genuine RPC business/runtime error -- including "Lease not found",
//      which contains the word "not found" but is NOT a missing-schema
//      condition -- still throws directly and does not attempt any
//      fallback or get remapped to the unavailable-workflow message.
const fromMock = vi.fn(() => ({
  update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  select: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }),
  }),
}));
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

vi.mock('@/lib/orgUtils', () => ({
  resolveWritableOrgScopeForUser: vi.fn().mockReturnValue({ scope: 'org', orgId: '123e4567-e89b-12d3-a456-426614174000' }),
  resolveReadableOrgScopeForUser: vi.fn().mockReturnValue({ scope: 'org', orgId: '123e4567-e89b-12d3-a456-426614174000' }),
}));

vi.mock('@/lib/actingOrg', () => ({
  getStoredActingOrgId: vi.fn().mockReturnValue('123e4567-e89b-12d3-a456-426614174000'),
  setStoredActingOrgId: vi.fn(),
  clearStoredActingOrgId: vi.fn(),
}));

vi.mock('@/lib/userPermissions', () => ({
  assertCanWritePage: vi.fn(),
  canWritePage: vi.fn().mockReturnValue(true),
  isPagePermissionError: vi.fn().mockReturnValue(false),
}));

vi.mock('@/services/auth', () => ({
  me: vi.fn().mockResolvedValue({
    id: 'user-123',
    email: 'test@example.com',
    role: 'org_admin',
    _raw_role: 'org_admin',
    org_id: '123e4567-e89b-12d3-a456-426614174000',
    memberships: [{ org_id: '123e4567-e89b-12d3-a456-426614174000', role: 'org_admin', status: 'active' }],
  }),
}));

describe('leaseService.delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockClear();
    rpcMock.mockReset();
  });

  it('returns true when delete_lease_cascade succeeds', async () => {
    rpcMock.mockResolvedValue({ error: null });

    const result = await leaseService.delete('lease-1');

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('delete_lease_cascade', expect.objectContaining({ target_lease_id: 'lease-1' }));
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws the clear unavailable-workflow error on a schema-cache-miss, with zero fallback table calls', async () => {
    rpcMock.mockResolvedValue({
      error: { code: 'PGRST202', message: 'Could not find the function public.delete_lease_cascade' },
    });

    await expect(leaseService.delete('lease-2')).rejects.toThrow(
      'Lease deletion is temporarily unavailable because the server-side delete workflow is not deployed. Please contact support or retry after migrations are applied.'
    );
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws the clear unavailable-workflow error for a message-only "schema cache" miss with no recognized code', async () => {
    rpcMock.mockResolvedValue({
      error: { code: undefined, message: 'Could not find function delete_lease_cascade in schema cache' },
    });

    await expect(leaseService.delete('lease-3')).rejects.toThrow(
      /temporarily unavailable/
    );
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws the clear unavailable-workflow error for a "function ... does not exist" message naming delete_lease_cascade', async () => {
    rpcMock.mockResolvedValue({
      error: { code: '42883', message: 'function delete_lease_cascade(uuid, uuid, text) does not exist' },
    });

    await expect(leaseService.delete('lease-3b')).rejects.toThrow(
      /temporarily unavailable/
    );
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('passes through "Lease not found" unchanged -- it must NOT be misclassified as a missing-schema error', async () => {
    rpcMock.mockResolvedValue({
      error: { code: 'P0001', message: 'Lease not found' },
    });

    await expect(leaseService.delete('lease-3c')).rejects.toThrow('Lease not found');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws the original error directly for a genuine business/runtime RPC failure, with zero fallback table calls', async () => {
    rpcMock.mockResolvedValue({
      error: { code: '23503', message: 'update or delete on table "leases" violates foreign key constraint' },
    });

    await expect(leaseService.delete('lease-4')).rejects.toThrow('violates foreign key constraint');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws the original error directly for a permission-denied RPC failure, with zero fallback table calls', async () => {
    rpcMock.mockResolvedValue({
      error: { code: '42501', message: 'permission denied for function delete_lease_cascade' },
    });

    await expect(leaseService.delete('lease-5')).rejects.toThrow('permission denied');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('requires a lease id', async () => {
    await expect(leaseService.delete(null)).rejects.toThrow('Lease ID is required for deletion');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
