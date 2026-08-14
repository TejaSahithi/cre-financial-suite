export interface FinancialControlExpense {
  amount?: number | string | null;
  category?: string | null;
  expense_subcategory?: string | null;
  status?: string | null;
  date?: string | null;
  expense_date?: string | null;
  month?: number | string | null;
}

export interface FinancialControlBudget {
  budget_year?: number | string | null;
  fiscal_year?: number | string | null;
  total_expenses?: number | string | null;
  expense_items?: unknown;
  line_items?: unknown;
}

const APPROVED_STATUSES = new Set(["approved", "posted", "paid", "finalized"]);
export interface FinancialControlException {
  code: string;
  category: string;
  budget: number;
  actual: number;
  variancePercent: number | null;
}

export function normalizeFinancialControlCategory(value: unknown): string {
  return String(value || "uncategorized").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "uncategorized";
}

function asNumber(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
  } catch {
    return [];
  }
}

function yearFromDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

export function evaluateFinancialControls(input: {
  expenses?: FinancialControlExpense[];
  budgets?: FinancialControlBudget[];
  fiscalYear: number;
  varianceThresholdPercent?: number;
}) {
  const threshold = input.varianceThresholdPercent ?? 25;
  const budgetTotals = new Map<string, number>();
  for (const budget of input.budgets ?? []) {
    const year = Number(budget.budget_year ?? budget.fiscal_year);
    if (year && year !== input.fiscalYear) continue;
    const items = [...parseItems(budget.expense_items), ...parseItems(budget.line_items)];
    for (const item of items) {
      const category = normalizeFinancialControlCategory(item.category ?? item.category_name ?? item.normalized_key);
      budgetTotals.set(category, (budgetTotals.get(category) ?? 0) + asNumber(item.amount ?? item.annual_amount ?? item.budget_amount));
    }
    if (items.length === 0 && asNumber(budget.total_expenses) > 0) {
      budgetTotals.set("total_operating_expenses", (budgetTotals.get("total_operating_expenses") ?? 0) + asNumber(budget.total_expenses));
    }
  }

  const actualTotals = new Map<string, number>();
  for (const expense of input.expenses ?? []) {
    const status = String(expense.status || "").toLowerCase();
    if (status && !APPROVED_STATUSES.has(status)) continue;
    const year = yearFromDate(expense.date ?? expense.expense_date);
    if (year && year !== input.fiscalYear) continue;
    const category = normalizeFinancialControlCategory(expense.category ?? expense.expense_subcategory);
    actualTotals.set(category, (actualTotals.get(category) ?? 0) + asNumber(expense.amount));
  }

  const categories = [...new Set([...budgetTotals.keys(), ...actualTotals.keys()])];
  const exceptions: FinancialControlException[] = categories.flatMap((category): FinancialControlException[] => {
    const budget = budgetTotals.get(category) ?? 0;
    const actual = actualTotals.get(category) ?? 0;
    if (budget === 0 && actual > 0) return [{ code: "UNBUDGETED_EXPENSE", category, budget, actual, variancePercent: null }];
    const variancePercent = budget > 0 ? ((actual - budget) / budget) * 100 : 0;
    if (variancePercent > threshold) return [{ code: "CATEGORY_OVER_BUDGET", category, budget, actual, variancePercent }];
    return [];
  });

  return {
    status: exceptions.length > 0 ? "needs_review" : "clear",
    exceptions,
  };
}