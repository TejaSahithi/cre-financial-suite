import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  humanize,
  toNumber,
  buildAmountBuckets,
  leaseCoversYear,
  isClassificationSentToCam,
  isAutomaticCamReadyRow,
  canSendFinalizedActualToCam,
  buildClassificationRows,
  getCamInputDecision,
  getCamDecision,
  getClassificationRecoveryBucket,
  ruleExpectsLandlordActualExpense,
} from './buildClassificationRows';

describe('buildClassificationRows', () => {
  it('normalizeText lowercases and trims', () => {
    expect(normalizeText("  HeLLo  ")).toBe("hello");
  });

  it('humanize formats strings', () => {
    expect(humanize("test_key")).toBe("Test Key");
  });

  it('toNumber parses and falls back to 0', () => {
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber("invalid")).toBe(0);
    expect(toNumber(null)).toBe(0);
  });

  it('buildAmountBuckets distributes correctly', () => {
    const recoverable = buildAmountBuckets(100, "recoverable");
    expect(recoverable.recoverable_amount).toBe(100);
    expect(recoverable.non_recoverable_amount).toBe(0);

    const nonRecoverable = buildAmountBuckets(50, "non_recoverable");
    expect(nonRecoverable.non_recoverable_amount).toBe(50);
  });

  it('leaseCoversYear checks overlap correctly', () => {
    expect(leaseCoversYear({ start_date: "2020-01-01", end_date: "2025-12-31" }, 2024)).toBe(true);
    expect(leaseCoversYear({ start_date: "2020-01-01", end_date: "2025-12-31" }, 2026)).toBe(false);
  });


  it('merges an approved actual and its approved lease rule into one classification row', () => {
    const lease = {
      id: 'lease-1',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Tenant One',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    };
    const rule = {
      id: 'rule-1',
      lease_id: 'lease-1',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category: 'insurance',
      recoverable_from_tenant: 'yes',
      cam_eligible: 'yes',
    };
    const actual = {
      id: 'expense-1',
      lease_id: 'lease-1',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      category: 'insurance',
      amount: 150,
      date: '2025-08-03',
      vendor: 'ABC',
      approval_status: 'approved',
    };
    const classification = {
      id: 'classification-1',
      expense_id: 'expense-1',
      lease_expense_rule_id: 'rule-1',
      classification_status: 'matched',
      recoverability_result: 'recoverable',
      cam_eligible: 'yes',
    };

    const rows = buildClassificationRows({
      approvedActuals: [actual],
      approvedRules: [rule],
      existingClassifications: [classification],
      scopedLeases: [lease],
      leases: [lease],
      leaseById: new Map([[lease.id, lease]]),
      propertyById: new Map(),
      buildingById: new Map(),
      unitById: new Map(),
      tenantById: new Map([['tenant-1', { id: 'tenant-1', name: 'Tenant One' }]]),
      scopeYear: '2025',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].rowType).toBe('matched_classification');
    expect(rows[0].actualExpenseId).toBe('expense-1');
    expect(rows[0].leaseExpenseRuleId).toBe('rule-1');
  });
  it('does not mark finalized conditional rows as sendable to CAM', () => {
    const lease = {
      id: 'lease-conditional',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Tenant One',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    };
    const rule = {
      id: 'rule-conditional',
      lease_id: 'lease-conditional',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category: 'insurance',
      recoverable_from_tenant: 'conditional',
      cam_eligible: 'conditional',
      published_to_cam: true,
    };
    const actual = {
      id: 'expense-conditional',
      lease_id: 'lease-conditional',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      category: 'insurance',
      amount: 150,
      date: '2025-08-03',
      vendor: 'ABC',
      approval_status: 'approved',
    };
    const classification = {
      id: 'classification-conditional',
      expense_id: 'expense-conditional',
      lease_expense_rule_id: 'rule-conditional',
      classification_status: 'finalized',
      recoverability_result: 'conditional',
      cam_eligible: 'conditional',
    };

    const rows = buildClassificationRows({
      approvedActuals: [actual],
      approvedRules: [rule],
      existingClassifications: [classification],
      scopedLeases: [lease],
      leases: [lease],
      leaseById: new Map([[lease.id, lease]]),
      propertyById: new Map(),
      buildingById: new Map(),
      unitById: new Map(),
      tenantById: new Map([['tenant-1', { id: 'tenant-1', name: 'Tenant One' }]]),
      scopeYear: '2025',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].canSendToCam).toBe(false);
    expect(rows[0].canSendToReview).toBe(true);
  });
  it('allows finalized recoverable CAM-eligible rows to be sent even when the rule is not pre-published', () => {
    const lease = {
      id: 'lease-sendable',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Tenant One',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    };
    const rule = {
      id: 'rule-sendable',
      lease_id: 'lease-sendable',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category: 'insurance',
      recoverable_from_tenant: 'yes',
      cam_eligible: 'yes',
      approval_status: 'approved',
      published_to_cam: false,
    };
    const actual = {
      id: 'expense-sendable',
      lease_id: 'lease-sendable',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      category: 'insurance',
      amount: 150,
      date: '2025-08-03',
      vendor: 'ABC',
      approval_status: 'approved',
      review_status: 'approved',
    };
    const classification = {
      id: 'classification-sendable',
      expense_id: 'expense-sendable',
      lease_expense_rule_id: 'rule-sendable',
      classification_status: 'finalized',
      recoverability_result: 'recoverable',
      cam_eligible: 'yes',
      expense_category_id: 'category-1',
      service_period_start: '2025-08-01',
      service_period_end: '2025-08-31',
      sent_to_cam: false,
    };

    const rows = buildClassificationRows({
      approvedActuals: [actual],
      approvedRules: [rule],
      existingClassifications: [classification],
      scopedLeases: [lease],
      leases: [lease],
      leaseById: new Map([[lease.id, lease]]),
      propertyById: new Map([['property-1', { id: 'property-1', name: 'Property One' }]]),
      buildingById: new Map(),
      unitById: new Map(),
      tenantById: new Map([['tenant-1', { id: 'tenant-1', name: 'Tenant One' }]]),
      scopeYear: '2025',
    });

    expect(rows[0].canSendToCam).toBe(true);
    expect(isAutomaticCamReadyRow(rows[0])).toBe(false);
    expect(rows[0].nextStep).toBe('Send to CAM');
  });
  it('isClassificationSentToCam detects sent status', () => {
    expect(isClassificationSentToCam({ sent_to_cam: true })).toBe(true);
    expect(isClassificationSentToCam({ cam_status: 'cam_ready' })).toBe(false);
    expect(isClassificationSentToCam({ cam_status: 'needs_review' })).toBe(false);
  });

  it('uses expense_classification cam_eligible=no as authoritative exclusion', () => {
    const classification = {
      id: 'classification-excluded',
      classification_status: 'finalized',
      recoverability_result: 'recoverable',
      cam_eligible: 'no',
    };
    const row = {
      rowType: 'matched_classification',
      actualExpenseId: 'expense-excluded',
      classificationStatus: 'finalized',
      recoverabilityResult: 'recoverable',
      camEligible: 'no',
      amount: 20400,
      property: { id: 'property-1' },
      expenseCategoryId: 'category-1',
      servicePeriodStart: '2026-01-01',
      servicePeriodEnd: '2026-01-31',
      classificationRecord: classification,
      rule: { published_to_cam: true, recoverable_from_tenant: 'yes', cam_eligible: 'yes' },
    };

    expect(getClassificationRecoveryBucket(classification)).toBe('excluded');
    expect(getCamInputDecision(row).state).toBe('not_cam_eligible');
  });

  it('treats published CAM as true only when cam_expense_inputs publication status is published', () => {
    const row = {
      rowType: 'matched_classification',
      actualExpenseId: 'expense-published',
      classificationStatus: 'finalized',
      recoverabilityResult: 'recoverable',
      camEligible: 'yes',
      amount: 100,
      sentToCam: true,
      property: { id: 'property-1' },
      expenseCategoryId: 'category-1',
      servicePeriodStart: '2026-01-01',
      servicePeriodEnd: '2026-01-31',
      classificationRecord: { recoverability_result: 'recoverable', cam_eligible: 'yes', classification_status: 'finalized' },
      rule: { published_to_cam: true, recoverable_from_tenant: 'yes', cam_eligible: 'yes' },
    };

    expect(getCamInputDecision(row).state).toBe('ready_to_send');
    expect(getCamInputDecision(row, { publicationStatus: 'published' }).state).toBe('published_to_cam');
  });

  it('keeps authoritative cam_eligible=no excluded even if legacy cam_status says cam_ready', () => {
    const row = {
      rowType: 'matched_classification',
      actualExpenseId: 'expense-authoritative-excluded',
      classificationStatus: 'finalized',
      recoverabilityResult: 'recoverable',
      camEligible: 'no',
      camStatus: 'cam_ready',
      amount: 20400,
      property: { id: 'property-1' },
      expenseCategoryId: 'category-1',
      servicePeriodStart: '2026-01-01',
      servicePeriodEnd: '2026-01-31',
      classificationRecord: {
        recoverability_result: 'recoverable',
        cam_eligible: 'no',
        cam_status: 'cam_ready',
        classification_status: 'finalized',
      },
      rule: { published_to_cam: true, recoverable_from_tenant: 'yes', cam_eligible: 'yes' },
    };

    expect(getCamInputDecision(row).state).toBe('not_cam_eligible');
    expect(getCamDecision(row).label).toBe('Excluded');
    expect(canSendFinalizedActualToCam(row)).toBe(false);
  });

  it('creates coverage gaps only for approved landlord recoverable rules that expect actual expenses', () => {
    const lease = {
      id: 'lease-gap',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Tenant One',
      start_date: '2025-01-01',
      end_date: '2027-12-31',
    };
    const landlordTaxRule = {
      id: 'rule-tax',
      lease_id: lease.id,
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category: 'taxes',
      expense_subcategory: 'real_estate_taxes',
      payment_treatment: 'reimbursable',
      operational_responsibility: 'landlord',
      recoverable_from_tenant: 'yes',
      cam_eligible: 'yes',
      approval_status: 'approved',
    };
    const tenantUtilityRule = {
      id: 'rule-utilities',
      lease_id: lease.id,
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category: 'utilities',
      payment_treatment: 'tenant_direct_contract',
      operational_responsibility: 'tenant',
      recoverable_from_tenant: 'no',
      cam_eligible: 'no',
      approval_status: 'approved',
    };

    expect(ruleExpectsLandlordActualExpense(landlordTaxRule)).toBe(true);
    expect(ruleExpectsLandlordActualExpense(tenantUtilityRule)).toBe(false);

    const rows = buildClassificationRows({
      approvedActuals: [],
      approvedRules: [landlordTaxRule, tenantUtilityRule],
      existingClassifications: [],
      scopedLeases: [lease],
      leases: [lease],
      leaseById: new Map([[lease.id, lease]]),
      propertyById: new Map([['property-1', { id: 'property-1', name: 'Property One' }]]),
      buildingById: new Map(),
      unitById: new Map(),
      tenantById: new Map([['tenant-1', { id: 'tenant-1', name: 'Tenant One' }]]),
      scopeYear: '2026',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].leaseExpenseRuleId).toBe('rule-tax');
    expect(rows[0].rowType).toBe('rule_missing_actual');
    expect(rows[0].financialAmount).toBe(0);
    expect(rows[0].recoverableAmount).toBe(0);
    expect(rows[0].canSendToCam).toBe(false);
  });

  it('uses the matched lease rule canonical category when the persisted classification only has a label', () => {
    const lease = {
      id: 'lease-category-fallback',
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Tenant One',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    };
    const rule = {
      id: 'rule-category-fallback',
      lease_id: lease.id,
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      expense_category_id: 'category-uuid-1',
      expense_category: 'real_estate_taxes',
      payment_treatment: 'reimbursable',
      operational_responsibility: 'landlord',
      recoverable_from_tenant: 'yes',
      cam_eligible: 'yes',
      approval_status: 'approved',
      published_to_cam: true,
    };
    const actual = {
      id: 'expense-category-fallback',
      lease_id: lease.id,
      property_id: 'property-1',
      building_id: 'building-1',
      unit_id: 'unit-1',
      tenant_id: 'tenant-1',
      category: 'real_estate_taxes',
      amount: 6800,
      expense_date: '2026-03-15',
      service_period_start: '2026-03-01',
      service_period_end: '2026-03-31',
      approval_status: 'approved',
      review_status: 'approved',
    };
    const classification = {
      id: 'classification-category-fallback',
      expense_id: actual.id,
      lease_expense_rule_id: rule.id,
      category: 'real_estate_taxes',
      expense_category_id: null,
      classification_status: 'finalized',
      recoverability_result: 'recoverable',
      cam_eligible: 'yes',
      service_period_start: '2026-03-01',
      service_period_end: '2026-03-31',
    };

    const rows = buildClassificationRows({
      approvedActuals: [actual],
      approvedRules: [rule],
      existingClassifications: [classification],
      scopedLeases: [lease],
      leases: [lease],
      leaseById: new Map([[lease.id, lease]]),
      propertyById: new Map([['property-1', { id: 'property-1', name: 'Property One' }]]),
      buildingById: new Map(),
      unitById: new Map(),
      tenantById: new Map([['tenant-1', { id: 'tenant-1', name: 'Tenant One' }]]),
      scopeYear: '2026',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].expenseCategoryId).toBe('category-uuid-1');
    expect(getCamInputDecision(rows[0]).state).toBe('ready_to_send');
  });

  describe('getCamInputDecision - direct recovery', () => {
    // Direct-recovery scenario 2/4: a finalized, CAM-eligible, categorized,
    // scoped, service-period-complete expense matched to a direct_bill rule
    // (recovery_method='direct_bill', billed to one specific tenant, never
    // pro-rated across a shared pool) but with no resolvable tenant on the
    // lease. Distinct from "Needs Scope"/"Needs Category" -- everything else
    // about the row is ready, only the direct-tenant identity is missing.
    it('flags "Needs Direct Tenant" for a direct_bill rule with no resolvable tenant', () => {
      const row = {
        rowType: 'matched_classification',
        actualExpenseId: 'expense-1',
        classificationStatus: 'finalized',
        recoverabilityResult: 'recoverable',
        camEligible: 'yes',
        expenseCategoryId: 'category-1',
        servicePeriodStart: '2026-01-01',
        servicePeriodEnd: '2026-01-31',
        property: { id: 'property-1' },
        sentToCam: false,
        classificationRecord: { id: 'classification-1' },
        rule: { recovery_method: 'direct_bill', payment_treatment: 'reimbursable' },
        tenantResolution: { tenant: null },
      };
      expect(getCamInputDecision(row).state).toBe('needs_direct_tenant');
    });

    it('resolves to "Ready to Send to CAM" once the direct tenant is resolved', () => {
      const row = {
        rowType: 'matched_classification',
        actualExpenseId: 'expense-1',
        classificationStatus: 'finalized',
        recoverabilityResult: 'recoverable',
        camEligible: 'yes',
        expenseCategoryId: 'category-1',
        servicePeriodStart: '2026-01-01',
        servicePeriodEnd: '2026-01-31',
        property: { id: 'property-1' },
        amount: 100,
        sentToCam: false,
        classificationRecord: { id: 'classification-1' },
        rule: { recovery_method: 'direct_bill', payment_treatment: 'reimbursable', published_to_cam: true },
        tenantResolution: { tenant: { id: 'tenant-1', name: 'Direct Tenant' } },
      };
      expect(getCamInputDecision(row).state).toBe('ready_to_send');
    });
  });
});
