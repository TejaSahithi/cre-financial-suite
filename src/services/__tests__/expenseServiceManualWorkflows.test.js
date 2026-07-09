import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature: enterprise-readiness-hardening Phase 6X-6 (manual_override_expense_classification
// / save_lease_rule_amount_cam_input). These wrappers are thin pass-throughs to their edge
// functions -- the real validation/idempotency/audit behavior is covered by
// supabase/functions/_tests/manual-override-expense-classification.property.test.ts and
// supabase/functions/_tests/save-lease-rule-amount-cam-input.property.test.ts. These tests
// only prove the frontend call sites send the right shape and no longer perform any direct
// supabase.from("expense_classifications").update()/upsert() write themselves.
const { invokeEdgeFunctionMock, sendToCamMock, isRuleCamPublishableMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
  sendToCamMock: vi.fn(),
  isRuleCamPublishableMock: vi.fn(),
}));

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

vi.mock('@/services/leaseExpenseRuleService', () => ({
  leaseExpenseRuleService: {
    isRuleCamPublishable: (...args) => isRuleCamPublishableMock(...args),
    getPaymentTreatment: vi.fn(),
    getCamEligibleDecision: vi.fn(),
  },
}));

vi.mock('@/services/expenseClassificationWorkflowService', () => ({
  createExpenseClassificationCamSendIdempotencyKey: vi.fn(() => 'idempotency-key'),
  sendExpenseClassificationToCam: (...args) => sendToCamMock(...args),
  reviewExpenseClassification: vi.fn(),
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

const { expenseService } = await import('@/services/expenseService');

describe('expenseService.markManualOverride', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('calls manual-override-expense-classification with the classification id and payload fields', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      changed: true,
      classification: { id: 'classification-1', classification_status: 'finalized' },
      audit_log_id: 'audit-1',
    });

    const result = await expenseService.markManualOverride('classification-1', {
      override_reason: 'Lease amendment allows recovery',
      override_type: 'cam_eligibility',
      override_previous_value: { cam_eligible: 'no' },
      override_new_value: { cam_eligible: 'yes' },
    });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('manual-override-expense-classification', {
      classification_id: 'classification-1',
      override_reason: 'Lease amendment allows recovery',
      override_type: 'cam_eligibility',
      override_previous_value: { cam_eligible: 'no' },
      override_new_value: { cam_eligible: 'yes' },
    });
    expect(result.id).toBe('classification-1');
    expect(result.classification_status).toBe('finalized');
  });

  it('returns null when the edge function reports no classification', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, changed: false, classification: null });

    const result = await expenseService.markManualOverride('classification-2', { override_reason: 'x' });
    expect(result).toBeNull();
  });
});

describe('expenseService.createLeaseRuleAmountCamInput', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
    sendToCamMock.mockReset();
    isRuleCamPublishableMock.mockReset();
    isRuleCamPublishableMock.mockReturnValue(true);
  });

  it('calls save-lease-rule-amount-cam-input with the rule id and classification patch, then sends to CAM', async () => {
    invokeEdgeFunctionMock.mockImplementation((fnName) => {
      if (fnName === 'save-lease-rule-amount-cam-input') {
        return Promise.resolve({
          error: false,
          changed: true,
          classification: { id: 'classification-9', row_type: 'rule_missing_actual' },
          audit_log_id: 'audit-9',
        });
      }
      if (fnName === 'update-lease-expense-rule-amount') {
        return Promise.resolve({ error: false });
      }
      throw new Error(`unexpected edge function call: ${fnName}`);
    });
    sendToCamMock.mockResolvedValue({ id: 'classification-9', sent_to_cam: true });

    const rule = {
      id: 'rule-1',
      org_id: '123e4567-e89b-12d3-a456-426614174000',
      published_to_cam: true,
      property_id: 'property-1',
      lease_id: 'lease-1',
      tenant_id: 'tenant-1',
      expense_category: 'cam_maintenance',
    };

    const result = await expenseService.createLeaseRuleAmountCamInput(rule, 1500, 2026);

    const saveCall = invokeEdgeFunctionMock.mock.calls.find(([fnName]) => fnName === 'save-lease-rule-amount-cam-input');
    expect(saveCall).toBeTruthy();
    const [, payload] = saveCall;
    expect(payload.rule_id).toBe('rule-1');
    expect(payload.classification.amount).toBe(1500);
    expect(payload.classification.fiscal_year).toBe(2026);
    expect(payload.classification.property_id).toBe('property-1');
    expect(payload.classification.lease_id).toBe('lease-1');
    // These are now hardcoded server-side, never sent by the client.
    expect(payload.classification.cam_status).toBeUndefined();
    expect(payload.classification.recoverability_result).toBeUndefined();

    expect(sendToCamMock).toHaveBeenCalledWith(expect.objectContaining({ classificationId: 'classification-9' }));
    expect(result.sent_to_cam).toBe(true);
  });

  it('rejects an invalid amount without calling any edge function', async () => {
    await expect(expenseService.createLeaseRuleAmountCamInput({ id: 'rule-1' }, -5, 2026)).rejects.toThrow(
      'Enter a valid amount'
    );
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('rejects a rule that is not CAM-publishable without calling any edge function', async () => {
    isRuleCamPublishableMock.mockReturnValue(false);
    await expect(expenseService.createLeaseRuleAmountCamInput({ id: 'rule-1' }, 500, 2026)).rejects.toThrow(
      'Only approved, CAM-eligible lease rules'
    );
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});
