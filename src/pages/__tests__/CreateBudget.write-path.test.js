import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Enterprise hardening Phase 4B: every budget status transition CreateBudget.jsx
// offers (generate, mark as reviewed, approve, reject/rework, lock) must go
// through compute-budget instead of a direct budgetService.update()/
// BudgetService.create() write. There is no React Testing Library / component
// mounting convention in this repo (checked: no test anywhere calls render()),
// so this asserts the property directly against the source instead of
// introducing a new, heavier test pattern for one page. This is a real
// regression guard: it fails the moment a direct write is reintroduced.
const CREATE_BUDGET_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../CreateBudget.jsx",
);

const source = readFileSync(CREATE_BUDGET_PATH, "utf8");

describe("CreateBudget.jsx write path (Phase 4B)", () => {
  it("never calls budgetService.update or BudgetService.create for status transitions", () => {
    expect(source).not.toMatch(/budgetService\.update\s*\(/);
    expect(source).not.toMatch(/BudgetService\.create\s*\(/);
  });

  it("does not import the direct-write budgetService module at all", () => {
    expect(source).not.toMatch(/from\s+["']@\/services\/budgetService["']/);
  });

  it("routes generate, mark_reviewed, approve, reject, and lock through compute-budget", () => {
    expect(source).toMatch(/invokeEdgeFunction\(\s*["']compute-budget["']/);
    expect(source).toMatch(/action:\s*["']generate["']/);
    expect(source).toMatch(/action:\s*["']mark_reviewed["']/);
    expect(source).toMatch(/action:\s*["']approve["']/);
    expect(source).toMatch(/action:\s*["']reject["']/);
    expect(source).toMatch(/action:\s*["']lock["']/);
  });
});
