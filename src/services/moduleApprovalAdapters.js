import { createWorkflowInstance } from "@/services/approvalWorkflowEngine";

function entityId(row = {}) {
  if (!row.id) throw new Error("entity id is required");
  return row.id;
}

function orgId(row = {}) {
  const resolved = row.org_id || row.organization_id;
  if (!resolved) throw new Error("org id is required");
  return resolved;
}

function hierarchyResource(row = {}) {
  return {
    org_id: row.org_id || row.organization_id,
    portfolio_id: row.portfolio_id || null,
    property_id: row.property_id || null,
    building_id: row.building_id || null,
    unit_id: row.unit_id || null,
    lease_id: row.lease_id || null,
  };
}

export function buildApprovalWorkflowInput({ workflowType, entityType, entity, amount, policies = [], submittedBy = null, metadata = {} }) {
  return {
    orgId: orgId(entity),
    workflowType,
    entityType,
    entityId: entityId(entity),
    amount,
    resource: hierarchyResource(entity),
    policies,
    submittedBy,
    metadata,
  };
}

export function submitExpenseApprovalWorkflow({ expense, policies = [], submittedBy = null, metadata = {} }) {
  return createWorkflowInstance(buildApprovalWorkflowInput({
    workflowType: "expense",
    entityType: "expense",
    entity: expense,
    amount: expense.amount ?? expense.total_amount ?? 0,
    policies,
    submittedBy,
    metadata,
  }));
}

export function submitBudgetApprovalWorkflow({ budget, policies = [], submittedBy = null, metadata = {} }) {
  return createWorkflowInstance(buildApprovalWorkflowInput({
    workflowType: "budget",
    entityType: "budget",
    entity: budget,
    amount: budget.total_expenses ?? budget.total_amount ?? budget.amount ?? 0,
    policies,
    submittedBy,
    metadata: {
      budget_year: budget.budget_year || budget.fiscal_year || null,
      version: budget.version || budget.budget_version || null,
      ...metadata,
    },
  }));
}

export function submitLeaseApprovalWorkflow({ lease, policies = [], submittedBy = null, metadata = {} }) {
  return createWorkflowInstance(buildApprovalWorkflowInput({
    workflowType: "lease",
    entityType: "lease",
    entity: lease,
    amount: lease.total_contract_value ?? lease.annual_rent ?? lease.monthly_rent ?? 0,
    policies,
    submittedBy,
    metadata: {
      lease_status: lease.status || null,
      ...metadata,
    },
  }));
}

export function submitCamApprovalWorkflow({ camRun, policies = [], submittedBy = null, metadata = {} }) {
  return createWorkflowInstance(buildApprovalWorkflowInput({
    workflowType: "cam",
    entityType: "cam",
    entity: camRun,
    amount: camRun.total_recoverable ?? camRun.total_amount ?? camRun.amount ?? 0,
    policies,
    submittedBy,
    metadata: {
      fiscal_year: camRun.fiscal_year || camRun.year || null,
      ...metadata,
    },
  }));
}
