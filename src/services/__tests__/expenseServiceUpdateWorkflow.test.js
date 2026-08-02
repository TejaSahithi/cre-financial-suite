import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature: enterprise-readiness-hardening Phase 6X-3 (update_expense_details).
// This wrapper fetches the current row via the generic entity service, merges
// the edit, re-derives the lease link client-side (resolveExpenseLeaseLink,
// unchanged), then hands a canonical actual-expense whitelist to the edge function --
// the real validation/idempotency/audit behavior is covered by
// supabase/functions/_tests/update-expense-details.property.test.ts. This
// test only proves the frontend call site sends the right shape and no
// longer performs any direct supabase.from("expenses").update() write itself.
const { invokeEdgeFunctionMock, expenseEntityMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
  expenseEntityMock: { get: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn(), list: vi.fn() },
}));

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createEntityService: (entityName) =>
      entityName === 'Expense' ? expenseEntityMock : actual.createEntityService(entityName),
  };
});

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

const { expenseService } = await import('@/services/expenseService');

describe('expenseService.updateExpenseWorkflow', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
    expenseEntityMock.get.mockReset();
    expenseEntityMock.update.mockReset();
  });

  it('fetches the current expense, merges the edit, and calls update-expense-details with the canonical actual-expense payload', async () => {
    expenseEntityMock.get.mockResolvedValue({
      id: 'expense-1',
      org_id: '123e4567-e89b-12d3-a456-426614174000',
      date: '2026-01-01',
      amount: 1000,
      category: 'CAM',
      vendor: 'Old Vendor',
      vendor_id: null,
      description: 'old',
      classification: null,
      portfolio_id: null,
      property_id: 'property-1',
      building_id: null,
      unit_id: null,
      attachment_url: null,
      lease_id: null,
      tenant_id: null,
      source: 'manual',
      fiscal_year: 2026,
      approval_status: 'pending',
      review_status: 'pending',
      service_period_start: '2026-01-01',
      service_period_end: '2026-01-01',
    });

    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      changed: true,
      expense: { id: 'expense-1', amount: 1750, vendor: 'New Vendor' },
      audit_log_id: 'audit-1',
    });

    const result = await expenseService.updateExpenseWorkflow('expense-1', {
      amount: 1750,
      vendor: 'New Vendor',
    });

    expect(expenseEntityMock.get).toHaveBeenCalledWith('expense-1');
    expect(invokeEdgeFunctionMock).toHaveBeenCalledTimes(1);
    const [fnName, payload] = invokeEdgeFunctionMock.mock.calls[0];
    expect(fnName).toBe('update-expense-details');
    expect(payload.expense_id).toBe('expense-1');
    expect(payload.expense.amount).toBe(1750);
    expect(payload.expense.vendor).toBe('New Vendor');
    expect(payload.expense.category).toBe('CAM');
    expect(payload.expense.property_id).toBe('property-1');
    // Status aliases stay synced so the grid and classification workflows read the same value.
    expect(payload.expense.approval_status).toBe('pending');
    expect(payload.expense.approved_status).toBe('pending');
    expect(payload.expense.review_status).toBe('pending');
    expect(result.id).toBe('expense-1');
    expect(result.amount).toBe(1750);

    // The frontend call site must not perform a direct entity-service write.
    expect(expenseEntityMock.update).not.toHaveBeenCalled();
  });

  it('returns null when the edge function reports no expense', async () => {
    expenseEntityMock.get.mockResolvedValue({
      id: 'expense-2',
      org_id: '123e4567-e89b-12d3-a456-426614174000',
      date: '2026-01-01',
      amount: 500,
      category: 'CAM',
      vendor: 'Vendor',
      property_id: 'property-1',
    });
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, changed: false, expense: null });

    const result = await expenseService.updateExpenseWorkflow('expense-2', {});
    expect(result).toBeNull();
  });

  it('keeps an explicitly tenantless property expense from auto-linking to the only lease', async () => {
    const result = await expenseService.resolveExpenseLeaseLink(
      {
        property_id: 'property-1',
        tenant_id: null,
        lease_id: null,
        skip_lease_resolution: true,
      },
      [{
        id: 'lease-1',
        property_id: 'property-1',
        tenant_id: 'tenant-1',
        status: 'active',
      }]
    );

    expect(result.lease).toBeNull();
    expect(result.expense.tenant_id).toBeNull();
    expect(result.expense.lease_id).toBeNull();
    expect(result.expense.skip_lease_resolution).toBeUndefined();
  });
});
