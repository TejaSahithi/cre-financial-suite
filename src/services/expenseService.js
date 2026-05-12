import { createEntityService } from '@/services/api';

const baseExpenseService = createEntityService('Expense');

const LEASE_DERIVED_EXPENSES = [
  {
    field: 'cam_amount',
    category: 'cam',
    label: 'CAM',
  },
  {
    field: 'nnn_amount',
    category: 'nnn',
    label: 'NNN',
  },
];

const SYNCABLE_LEASE_STATUSES = new Set(['active', 'approved', 'budget_ready', 'executed']);

function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeLeaseStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function leaseOverlapsFiscalYear(lease, fiscalYear) {
  if (!fiscalYear) return true;

  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T23:59:59`) : null;
  const yearStart = new Date(fiscalYear, 0, 1);
  const yearEnd = new Date(fiscalYear, 11, 31, 23, 59, 59);

  if (start && Number.isNaN(start.getTime())) return true;
  if (end && Number.isNaN(end.getTime())) return true;

  if (start && start > yearEnd) return false;
  if (end && end < yearStart) return false;
  return true;
}

function deriveLeaseExpenseFiscalYear(lease) {
  const currentYear = new Date().getFullYear();
  if (leaseOverlapsFiscalYear(lease, currentYear)) {
    return currentYear;
  }

  const startYear = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(startYear)) {
    return startYear;
  }

  const endYear = lease?.end_date ? new Date(`${lease.end_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(endYear)) {
    return endYear;
  }

  return currentYear;
}

function deriveLeaseExpenseDate(lease, fiscalYear) {
  const startDate = typeof lease?.start_date === 'string' ? lease.start_date : '';
  if (startDate && startDate.startsWith(`${fiscalYear}-`)) {
    return startDate;
  }
  return `${fiscalYear}-01-01`;
}

function expenseSyncKey({ lease_id, category, fiscal_year }) {
  return [lease_id || '', category || '', fiscal_year || ''].join('::');
}

function buildPropertyLookup(properties = []) {
  if (properties instanceof Map) return properties;
  return new Map((properties || []).map((property) => [property.id, property]));
}

function buildLeaseDerivedPayloads(lease, propertyById) {
  const status = normalizeLeaseStatus(lease?.status);
  if (!SYNCABLE_LEASE_STATUSES.has(status)) return [];
  if (!lease?.id || !lease?.property_id) return [];

  const fiscalYear = deriveLeaseExpenseFiscalYear(lease);
  const date = deriveLeaseExpenseDate(lease, fiscalYear);
  const month = Number(date.slice(5, 7)) || 1;
  const tenantName = String(lease.tenant_name || 'Lease');
  const property = propertyById.get(lease.property_id) || null;

  return LEASE_DERIVED_EXPENSES.flatMap((definition) => {
    const amount = toNumber(lease?.[definition.field]);
    if (amount <= 0) return [];

    return [{
      org_id: lease.org_id,
      portfolio_id: property?.portfolio_id || null,
      property_id: lease.property_id,
      building_id: lease.building_id || null,
      unit_id: lease.unit_id || null,
      lease_id: lease.id,
      category: definition.category,
      amount,
      classification: 'recoverable',
      vendor: tenantName,
      fiscal_year: fiscalYear,
      month,
      date,
      source: 'lease_import',
      allocation_type: 'direct',
      is_controllable: true,
      description: `${definition.label} imported from lease for ${tenantName}`,
    }];
  });
}

function shouldUpdateExpense(existingExpense, payload) {
  const comparableFields = [
    'org_id',
    'portfolio_id',
    'property_id',
    'building_id',
    'unit_id',
    'lease_id',
    'category',
    'amount',
    'classification',
    'vendor',
    'fiscal_year',
    'month',
    'date',
    'source',
    'allocation_type',
    'is_controllable',
    'description',
  ];

  return comparableFields.some((field) => {
    const existingValue = existingExpense?.[field] ?? null;
    const nextValue = payload?.[field] ?? null;
    return existingValue !== nextValue;
  });
}

export const expenseService = {
  ...baseExpenseService,

  async syncLeaseDerivedExpenses({ leases = [], existingExpenses = [], properties = [] } = {}) {
    const propertyById = buildPropertyLookup(properties);
    const targetPayloads = (leases || []).flatMap((lease) => buildLeaseDerivedPayloads(lease, propertyById));
    const leaseIds = new Set((leases || []).map((lease) => lease?.id).filter(Boolean));
    const relevantCategories = new Set(LEASE_DERIVED_EXPENSES.map((item) => item.category));

    const allExistingExpenses =
      Array.isArray(existingExpenses) && existingExpenses.length > 0
        ? existingExpenses
        : await baseExpenseService.list();

    const relevantExistingExpenses = (allExistingExpenses || []).filter((expense) =>
      expense?.source === 'lease_import' &&
      leaseIds.has(expense.lease_id) &&
      relevantCategories.has(expense.category)
    );

    const targetByKey = new Map(targetPayloads.map((payload) => [expenseSyncKey(payload), payload]));
    const existingByKey = new Map();
    const duplicateExistingExpenses = [];

    for (const expense of relevantExistingExpenses) {
      const key = expenseSyncKey({
        lease_id: expense.lease_id,
        category: expense.category,
        fiscal_year: expense.fiscal_year,
      });

      if (existingByKey.has(key)) {
        duplicateExistingExpenses.push(expense);
        continue;
      }

      existingByKey.set(key, expense);
    }

    const summary = { created: 0, updated: 0, deleted: 0 };

    for (const duplicateExpense of duplicateExistingExpenses) {
      const removed = await baseExpenseService.delete(duplicateExpense.id);
      if (removed) summary.deleted += 1;
    }

    for (const existingExpense of existingByKey.values()) {
      const key = expenseSyncKey({
        lease_id: existingExpense.lease_id,
        category: existingExpense.category,
        fiscal_year: existingExpense.fiscal_year,
      });

      if (!targetByKey.has(key)) {
        const removed = await baseExpenseService.delete(existingExpense.id);
        if (removed) summary.deleted += 1;
      }
    }

    for (const payload of targetPayloads) {
      const key = expenseSyncKey(payload);
      const existingExpense = existingByKey.get(key);

      if (!existingExpense) {
        await baseExpenseService.create(payload);
        summary.created += 1;
        continue;
      }

      if (shouldUpdateExpense(existingExpense, payload)) {
        await baseExpenseService.update(existingExpense.id, payload);
        summary.updated += 1;
      }
    }

    return summary;
  },
};
