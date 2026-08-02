import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature: enterprise-readiness-hardening Phase 6X-5 (bulk_create_expenses_workflow).
// This wrapper fetches the org's leases once (reused across every row) and
// re-derives each row's lease link client-side (resolveExpenseLeaseLink,
// unchanged), then hands a fixed field whitelist array to the edge function
// in one call -- the real validation/atomicity/audit behavior is covered by
// supabase/functions/_tests/bulk-create-expenses.property.test.ts. This test
// only proves the frontend call site sends the right shape, validates
// before calling out, and no longer performs any direct
// supabase.from("expenses").insert()/expenseService.create() write itself.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
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

const { expenseService } = await import('@/services/expenseService');

describe('expenseService.bulkCreateExpensesWorkflow', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('rejects an empty array without calling the edge function', async () => {
    await expect(expenseService.bulkCreateExpensesWorkflow([])).rejects.toThrow(
      'At least one expense row is required'
    );
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('builds the whitelisted payload for each row and calls bulk-create-expenses once', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      created_ids: ['expense-1', 'expense-2'],
      created_count: 2,
    });

    const rows = [
      {
        date: '2026-01-15',
        category: 'hvac_maintenance',
        amount: 1250,
        vendor: 'AZ Air Systems',
        description: 'Monthly HVAC service',
        classification: 'recoverable',
        source: 'bulk_import',
        source_type: 'bulk_import',
        expense_subcategory: 'repairs',
        gl_code: '5400',
        invoice_number: 'INV-2026-001',
        property_id: 'property-1',
      },
      {
        date: '2026-01-20',
        category: 'insurance',
        amount: 8500,
        vendor: 'SafeGuard Insurance',
        description: 'Annual property insurance premium',
        classification: 'recoverable',
        source: 'bulk_import',
        source_type: 'bulk_import',
        property_id: 'property-1',
      },
    ];

    const result = await expenseService.bulkCreateExpensesWorkflow(rows);

    expect(invokeEdgeFunctionMock).toHaveBeenCalledTimes(1);
    const [fnName, payload] = invokeEdgeFunctionMock.mock.calls[0];
    expect(fnName).toBe('bulk-create-expenses');
    expect(payload.expenses).toHaveLength(2);
    expect(payload.expenses[0].amount).toBe(1250);
    expect(payload.expenses[0].source).toBe('bulk_import');
    expect(payload.expenses[0].source_type).toBe('bulk_import');
    expect(payload.expenses[0].expense_subcategory).toBe('repairs');
    expect(payload.expenses[0].gl_code).toBe('5400');
    expect(payload.expenses[0].invoice_number).toBe('INV-2026-001');
    expect(payload.expenses[1].vendor).toBe('SafeGuard Insurance');
    // Bulk rows use the same canonical actual-expense payload shape as manual and invoice rows.
    expect(payload.expenses[0].approval_status).toBeUndefined();
    expect(payload.expenses[0].approved_status).toBeUndefined();
    expect(result.created_count).toBe(2);
  });
});
