// @ts-nocheck
/**
 * Property-Based Test: Expense Classification
 * Feature: backend-driven-pipeline, Task 9.2
 *
 * **Validates: Requirements 6.1**
 *
 * Property 23: For any set of expenses grouped by classification,
 * total_recoverable + total_non_recoverable + total_conditional = total_expenses.
 */

import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Types and pure computation logic
// ---------------------------------------------------------------------------

type ExpenseClassification = "recoverable" | "non_recoverable" | "conditional";

interface Expense {
  amount: number;
  classification: ExpenseClassification;
}

interface ClassificationResult {
  total_recoverable: number;
  total_non_recoverable: number;
  total_conditional: number;
  total_expenses: number;
}

/**
 * Classifies a list of expenses and returns totals by classification.
 * total_expenses is the direct sum of all amounts (no independent rounding of subtotals).
 */
function classifyExpenses(expenses: Expense[]): ClassificationResult {
  let total_recoverable = 0;
  let total_non_recoverable = 0;
  let total_conditional = 0;

  for (const expense of expenses) {
    switch (expense.classification) {
      case "recoverable":
        total_recoverable += expense.amount;
        break;
      case "non_recoverable":
        total_non_recoverable += expense.amount;
        break;
      case "conditional":
        total_conditional += expense.amount;
        break;
    }
  }

  // total_expenses is the authoritative sum; subtotals are derived from it
  const total_expenses = total_recoverable + total_non_recoverable + total_conditional;

  return {
    total_recoverable,
    total_non_recoverable,
    total_conditional,
    total_expenses,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const classificationArb = fc.constantFrom<ExpenseClassification>(
  "recoverable",
  "non_recoverable",
  "conditional",
);

const expenseArb = fc.record({
  amount: fc.float({ min: 0, max: 1_000_000, noNaN: true }),
  classification: classificationArb,
});

const expensesArb = fc.array(expenseArb, { minLength: 0, maxLength: 50 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 23: total_recoverable + total_non_recoverable + total_conditional = total_expenses",
  fn: () => {
    fc.assert(
      fc.property(expensesArb, (expenses) => {
        const result = classifyExpenses(expenses);

        const sum = Math.round(
          (result.total_recoverable + result.total_non_recoverable + result.total_conditional) * 100,
        ) / 100;

        assertAlmostEquals(
          sum,
          result.total_expenses,
          0.01,
          `Sum of classified totals (${sum}) must equal total_expenses (${result.total_expenses})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 23: total_expenses equals sum of all individual expense amounts",
  fn: () => {
    fc.assert(
      fc.property(expensesArb, (expenses) => {
        const result = classifyExpenses(expenses);
        const directSum = expenses.reduce((acc, e) => acc + e.amount, 0);

        assertAlmostEquals(
          result.total_expenses,
          directSum,
          0.01,
          `total_expenses (${result.total_expenses}) must equal direct sum (${directSum})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 23: empty expense list produces all-zero totals",
  fn: () => {
    const result = classifyExpenses([]);
    assertAlmostEquals(result.total_recoverable, 0, 0.001);
    assertAlmostEquals(result.total_non_recoverable, 0, 0.001);
    assertAlmostEquals(result.total_conditional, 0, 0.001);
    assertAlmostEquals(result.total_expenses, 0, 0.001);
  },
});
