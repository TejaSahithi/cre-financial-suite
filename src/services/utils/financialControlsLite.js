const APPROVED_STATUSES = new Set(["approved", "posted", "paid", "finalized"]);

export function normalizeControlCategory(value) {
  return String(value || "uncategorized")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "uncategorized";
}

function asNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getExpenseDate(expense) {
  return expense?.date || expense?.expense_date || expense?.service_period_start || expense?.created_at || null;
}

function getExpenseYear(expense) {
  const date = getExpenseDate(expense);
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

function getExpenseMonth(expense) {
  const explicit = Number(expense?.month);
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 12) return explicit;
  const date = getExpenseDate(expense);
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCMonth() + 1;
}

function parseLineItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function budgetLineItems(budget) {
  return [
    ...parseLineItems(budget?.expense_items),
    ...parseLineItems(budget?.line_items),
    ...parseLineItems(budget?.items),
  ];
}

export function summarizeBudgetByCategory(budgets = [], fiscalYear) {
  const totals = new Map();
  for (const budget of budgets) {
    const budgetYear = Number(budget?.budget_year || budget?.fiscal_year || budget?.year);
    if (fiscalYear && budgetYear && budgetYear !== Number(fiscalYear)) continue;
    for (const item of budgetLineItems(budget)) {
      const category = normalizeControlCategory(item?.category || item?.category_name || item?.normalized_key);
      totals.set(category, (totals.get(category) || 0) + asNumber(item?.amount || item?.annual_amount || item?.budget_amount));
    }
    if (totals.size === 0 && asNumber(budget?.total_expenses) > 0) {
      totals.set("total_operating_expenses", (totals.get("total_operating_expenses") || 0) + asNumber(budget.total_expenses));
    }
  }
  return totals;
}

export function summarizeActualsByCategory(expenses = [], fiscalYear) {
  const totals = new Map();
  const monthsByCategory = new Map();
  for (const expense of expenses) {
    const status = String(expense?.status || "").toLowerCase();
    if (status && !APPROVED_STATUSES.has(status)) continue;
    const expenseYear = getExpenseYear(expense);
    if (fiscalYear && expenseYear && expenseYear !== Number(fiscalYear)) continue;
    const category = normalizeControlCategory(expense?.category || expense?.expense_subcategory || expense?.category_name);
    totals.set(category, (totals.get(category) || 0) + asNumber(expense?.amount || expense?.actual_amount));
    const month = getExpenseMonth(expense);
    if (month) {
      if (!monthsByCategory.has(category)) monthsByCategory.set(category, new Set());
      monthsByCategory.get(category).add(month);
    }
  }
  return { totals, monthsByCategory };
}

export function deriveRecurringExpectations({ expenseRules = [], expenses = [], fiscalYear } = {}) {
  const expectations = new Map();

  for (const rule of expenseRules) {
    const frequency = String(rule?.frequency || rule?.billing_frequency || rule?.charge_frequency || "").toLowerCase();
    const hasMonthlySignal = frequency.includes("month") || asNumber(rule?.estimated_monthly_amount) > 0;
    if (!hasMonthlySignal) continue;
    const category = normalizeControlCategory(rule?.expense_category || rule?.category_name || rule?.category);
    expectations.set(category, {
      category,
      expectedCount: 12,
      source: "approved_lease_expense_rule",
    });
  }

  const { monthsByCategory } = summarizeActualsByCategory(expenses, fiscalYear ? Number(fiscalYear) - 1 : null);
  for (const [category, months] of monthsByCategory.entries()) {
    if (expectations.has(category) || months.size < 6) continue;
    expectations.set(category, {
      category,
      expectedCount: months.size,
      source: "prior_year_actual_pattern",
    });
  }

  return [...expectations.values()];
}

export function evaluateFinancialControlsLite({
  expenses = [],
  budgets = [],
  expenseRules = [],
  fiscalYear = new Date().getFullYear(),
  varianceThresholdPercent = 25,
} = {}) {
  const budgetByCategory = summarizeBudgetByCategory(budgets, fiscalYear);
  const actualSummary = summarizeActualsByCategory(expenses, fiscalYear);
  const actualByCategory = actualSummary.totals;
  const categories = [...new Set([...budgetByCategory.keys(), ...actualByCategory.keys()])];

  const categoryVariance = categories.map((category) => {
    const budget = budgetByCategory.get(category) || 0;
    const actual = actualByCategory.get(category) || 0;
    const variance = actual - budget;
    const variancePercent = budget > 0 ? (variance / budget) * 100 : null;
    const severity = budget > 0 && variancePercent > varianceThresholdPercent
      ? "review_required"
      : "ok";
    return { category, budget, actual, variance, variancePercent, severity };
  });

  const unbudgetedExpenses = categoryVariance
    .filter((row) => row.budget === 0 && row.actual > 0)
    .map((row) => ({ ...row, severity: "review_required", code: "UNBUDGETED_EXPENSE" }));

  const recurringExpectations = deriveRecurringExpectations({ expenseRules, expenses, fiscalYear });
  const missingRecurring = recurringExpectations
    .map((expectation) => {
      const actualCount = actualSummary.monthsByCategory.get(expectation.category)?.size || 0;
      return {
        ...expectation,
        actualCount,
        missingCount: Math.max(0, expectation.expectedCount - actualCount),
        severity: actualCount < expectation.expectedCount ? "review_required" : "ok",
        code: "EXPECTED_INVOICE_MISSING",
      };
    })
    .filter((row) => row.missingCount > 0);

  const overBudget = categoryVariance
    .filter((row) => row.severity === "review_required")
    .map((row) => ({ ...row, code: "CATEGORY_OVER_BUDGET" }));

  return {
    fiscalYear,
    controls: {
      categoryVariance,
      overBudget,
      unbudgetedExpenses,
      missingRecurring,
    },
    summary: {
      overBudgetCount: overBudget.length,
      unbudgetedCount: unbudgetedExpenses.length,
      missingRecurringCount: missingRecurring.length,
      totalExceptions: overBudget.length + unbudgetedExpenses.length + missingRecurring.length,
    },
  };
}
