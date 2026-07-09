import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expenseService } from '@/services/expenseService';

// Feature: enterprise-readiness-hardening Phase 6X-7A. syncLeaseDerivedExpenses'
// legacy lease_import cleanup delete step now routes through
// deleteExpensesWorkflow (Phase 6X-4's delete_expenses_workflow RPC) instead of
// a per-row baseExpenseService.delete() loop. The read/filter logic that
// decides which rows are legacy junk for the given lease(s) is unchanged.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('expenseService.syncLeaseDerivedExpenses', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('finds matching legacy lease_import rows and calls deleteExpensesWorkflow once with the full batch', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      deleted_ids: ['expense-1', 'expense-2'],
      deleted_count: 2,
    });

    const existingExpenses = [
      { id: 'expense-1', source_type: 'lease_import', lease_id: 'lease-1' },
      { id: 'expense-2', source: 'lease_import', lease_id: 'lease-1' },
      { id: 'expense-3', source_type: 'manual', lease_id: 'lease-1' },
      { id: 'expense-4', source_type: 'lease_import', lease_id: 'lease-other' },
    ];

    const result = await expenseService.syncLeaseDerivedExpenses({
      leases: [{ id: 'lease-1' }],
      existingExpenses,
    });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledTimes(1);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-expenses', {
      expense_ids: ['expense-1', 'expense-2'],
    });
    expect(result).toEqual({ created: 0, updated: 0, deleted: 2 });
  });

  it('makes zero delete calls when no matching legacy rows exist', async () => {
    const existingExpenses = [
      { id: 'expense-1', source_type: 'manual', lease_id: 'lease-1' },
      { id: 'expense-2', source_type: 'lease_import', lease_id: 'lease-other' },
    ];

    const result = await expenseService.syncLeaseDerivedExpenses({
      leases: [{ id: 'lease-1' }],
      existingExpenses,
    });

    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  it('makes zero delete calls and returns immediately when no leases are given', async () => {
    const result = await expenseService.syncLeaseDerivedExpenses({ leases: [] });

    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  it('propagates a deleteExpensesWorkflow failure without swallowing it internally (caller wraps it non-blocking)', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('One or more expense_ids were not found for this organization'));

    const existingExpenses = [
      { id: 'expense-1', source_type: 'lease_import', lease_id: 'lease-1' },
    ];

    await expect(
      expenseService.syncLeaseDerivedExpenses({ leases: [{ id: 'lease-1' }], existingExpenses })
    ).rejects.toThrow('not found for this organization');
  });
});
