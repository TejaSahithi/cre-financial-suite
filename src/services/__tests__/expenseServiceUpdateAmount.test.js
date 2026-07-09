import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expenseService } from '@/services/expenseService';

// Feature: enterprise-readiness-hardening Phase 6X-2 (update_expense_amount).
// This wrapper is a thin pass-through to the edge function -- the real
// validation/idempotency/audit behavior is covered by
// supabase/functions/_tests/update-expense-amount.property.test.ts. This
// test only proves the frontend call site sends the right shape, validates
// before calling out, and no longer performs any direct
// supabase.from("expenses").update() write itself.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
    })),
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

describe('expenseService.updateExpenseAmount', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('rejects an invalid amount without calling the edge function', async () => {
    await expect(expenseService.updateExpenseAmount('expense-1', -5)).rejects.toThrow('Enter a valid amount');
    await expect(expenseService.updateExpenseAmount('expense-1', 'not-a-number')).rejects.toThrow('Enter a valid amount');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('calls the update-expense-amount edge function with the expense id and numeric amount, no lease follow-up when lease_id is absent', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      changed: true,
      expense: { id: 'expense-1', amount: 1500, lease_id: null, org_id: '123e4567-e89b-12d3-a456-426614174000' },
      audit_log_id: 'audit-1',
    });

    const result = await expenseService.updateExpenseAmount('expense-1', '1500', { reason: 'Test reason' });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('update-expense-amount', {
      expense_id: 'expense-1',
      amount: 1500,
    });
    expect(result.id).toBe('expense-1');
    expect(result.amount).toBe(1500);
    expect(result.recovery_reason).toBe('Test reason');
  });

  it('throws when the edge function returns no expense', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, changed: false, expense: null });

    await expect(expenseService.updateExpenseAmount('expense-2', 100)).rejects.toThrow('Expense not found');
  });
});
