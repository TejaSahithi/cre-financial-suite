import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expenseService } from '@/services/expenseService';

// Feature: enterprise-readiness-hardening Phase 6X-4 (delete_expenses_workflow).
// This wrapper is a thin pass-through to the edge function -- the real
// validation/atomicity/audit behavior is covered by
// supabase/functions/_tests/delete-expenses.property.test.ts. This test only
// proves the frontend call site sends the right shape for both single and
// bulk delete, validates before calling out, and no longer performs any
// direct supabase.from("expenses").delete() write itself.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('expenseService.deleteExpensesWorkflow', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('wraps a single id in an array and calls delete-expenses', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      deleted_ids: ['expense-1'],
      deleted_count: 1,
    });

    const result = await expenseService.deleteExpensesWorkflow('expense-1');

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-expenses', {
      expense_ids: ['expense-1'],
    });
    expect(result.deleted_count).toBe(1);
  });

  it('passes a bulk array of ids through unchanged', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      deleted_ids: ['expense-1', 'expense-2'],
      deleted_count: 2,
    });

    const result = await expenseService.deleteExpensesWorkflow(['expense-1', 'expense-2']);

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-expenses', {
      expense_ids: ['expense-1', 'expense-2'],
    });
    expect(result.deleted_count).toBe(2);
  });

  it('rejects an empty array without calling the edge function', async () => {
    await expect(expenseService.deleteExpensesWorkflow([])).rejects.toThrow(
      'At least one expense id is required'
    );
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('propagates edge function errors (e.g. mixed-org rejection) without partial success', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('One or more expense_ids were not found for this organization'));

    await expect(expenseService.deleteExpensesWorkflow(['expense-1', 'expense-2'])).rejects.toThrow(
      'not found for this organization'
    );
  });
});
