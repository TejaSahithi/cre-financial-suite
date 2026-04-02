// @ts-nocheck
/**
 * Unit Tests: Budget Generation
 * Feature: backend-driven-pipeline, Task 12.4
 *
 * Requirements: 9.2, 9.3, 9.4, 9.5
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

type BudgetStatus = "draft" | "under_review" | "approved" | "locked";

interface BudgetLineItems {
  revenue: { total: number; [key: string]: number };
  expenses: { total: number; [key: string]: number };
  noi: number;
}

function computeNOI(totalRevenue: number, totalExpenses: number): number {
  return totalRevenue - totalExpenses;
}

function buildBudgetLineItems(
  baseRent: number,
  camRecovery: number,
  otherIncome: number,
  expensesByCategory: Record<string, number>,
): BudgetLineItems {
  const totalRevenue = baseRent + camRecovery + otherIncome;
  const totalExpenses = Object.values(expensesByCategory).reduce((s, v) => s + v, 0);
  const noi = computeNOI(totalRevenue, totalExpenses);
  return {
    revenue: { base_rent: baseRent, cam_recovery: camRecovery, other_income: otherIncome, total: totalRevenue },
    expenses: { ...expensesByCategory, total: totalExpenses },
    noi,
  };
}

// Valid transitions map
const TRANSITIONS: Record<BudgetStatus, BudgetStatus[]> = {
  draft: ["under_review"],
  under_review: ["approved", "draft"], // draft = rejected
  approved: ["locked"],
  locked: [],
};

function transitionBudget(current: BudgetStatus, next: BudgetStatus): BudgetStatus {
  const allowed = TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid transition: ${current} → ${next}`);
  }
  return next;
}

function canModifyBudget(status: BudgetStatus): boolean {
  return status !== "locked";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Budget with all line items: verify NOI = revenue - expenses
Deno.test("Budget line items: NOI = total_revenue - total_expenses", () => {
  const lineItems = buildBudgetLineItems(
    100_000, // base_rent
    10_000,  // cam_recovery
    5_000,   // other_income
    { utilities: 20_000, maintenance: 15_000, management: 10_000 },
  );

  const expectedRevenue = 115_000;
  const expectedExpenses = 45_000;
  const expectedNOI = 70_000;

  assertAlmostEquals(lineItems.revenue.total, expectedRevenue, 0.01, "Total revenue must be 115000");
  assertAlmostEquals(lineItems.expenses.total, expectedExpenses, 0.01, "Total expenses must be 45000");
  assertAlmostEquals(lineItems.noi, expectedNOI, 0.01, "NOI must be 70000");
  assertAlmostEquals(
    lineItems.noi,
    lineItems.revenue.total - lineItems.expenses.total,
    0.01,
    "NOI must equal revenue - expenses",
  );
});

Deno.test("Budget line items: NOI is negative when expenses exceed revenue", () => {
  const lineItems = buildBudgetLineItems(50_000, 0, 0, { expenses: 80_000 });
  assert(lineItems.noi < 0, "NOI must be negative when expenses exceed revenue");
  assertAlmostEquals(lineItems.noi, -30_000, 0.01, "NOI must be -30000");
});

// 2. Budget approval workflow: draft → under_review → approved → locked
Deno.test("Budget workflow: valid transitions draft → under_review → approved → locked", () => {
  let status: BudgetStatus = "draft";

  status = transitionBudget(status, "under_review");
  assertEquals(status, "under_review", "After submit: under_review");

  status = transitionBudget(status, "approved");
  assertEquals(status, "approved", "After approve: approved");

  status = transitionBudget(status, "locked");
  assertEquals(status, "locked", "After lock: locked");
});

Deno.test("Budget workflow: under_review can be rejected back to draft", () => {
  let status: BudgetStatus = "under_review";
  status = transitionBudget(status, "draft");
  assertEquals(status, "draft", "Rejected budget returns to draft");
});

// 3. Invalid transition: locked → draft should fail
Deno.test("Budget workflow: locked → draft is an invalid transition", () => {
  assertThrows(
    () => transitionBudget("locked", "draft"),
    Error,
    "Invalid transition",
    "Transitioning from locked to draft must throw",
  );
});

Deno.test("Budget workflow: locked budget cannot be modified", () => {
  assertEquals(canModifyBudget("locked"), false, "Locked budget must not be modifiable");
});

Deno.test("Budget workflow: draft budget can be modified", () => {
  assertEquals(canModifyBudget("draft"), true, "Draft budget must be modifiable");
});

Deno.test("Budget workflow: approved → draft is an invalid transition", () => {
  assertThrows(
    () => transitionBudget("approved", "draft"),
    Error,
    "Invalid transition",
    "Cannot go from approved directly to draft",
  );
});
