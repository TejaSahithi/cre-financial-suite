import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findingBlocksBudgetApproval,
  resolveFinancialControlPolicyDecision,
} from "../_shared/financial-controls/financial-control-policy.ts";

const migrationSql = await Deno.readTextFile(new URL("../../migrations/20269900000074_financial_control_policy_resolution.sql", import.meta.url));
const runControlsSource = await Deno.readTextFile(new URL("../run-financial-controls/index.ts", import.meta.url));
const commandSource = await Deno.readTextFile(new URL("../operational-review-command/index.ts", import.meta.url));
const automationSource = await Deno.readTextFile(new URL("../../../src/pages/AutomationReadiness.jsx", import.meta.url));
const budgetReviewSource = await Deno.readTextFile(new URL("../../../src/pages/BudgetReview.jsx", import.meta.url));

const finding = {
  org_id: "org-a",
  property_id: "property-a",
  workflow: "budget_approval",
  code: "BUDGET_VARIANCE",
  category: "repairs",
  severity: "medium",
  variance_percent: 32,
  variance_amount: 12000,
};

Deno.test("financial-control policy precedence prefers property/finding/severity/threshold specificity", () => {
  const decision = resolveFinancialControlPolicyDecision({
    finding,
    policies: [
      { id: "org-warn", org_id: "org-a", workflow: "budget_approval", action: "WARN" },
      { id: "property-block", org_id: "org-a", property_id: "property-a", workflow: "budget_approval", action: "BLOCK" },
      { id: "specific-ack", org_id: "org-a", property_id: "property-a", workflow: "budget_approval", finding_type: "BUDGET_VARIANCE", severity: "medium", threshold_min: 25, action: "REQUIRE_ACKNOWLEDGEMENT" },
    ],
    workflow: "budget_approval",
    resolvedAt: "2026-08-14T00:00:00Z",
  });
  assertEquals(decision.action, "REQUIRE_ACKNOWLEDGEMENT");
  assertEquals(decision.snapshot.matched_policy_id, "specific-ack");
});

Deno.test("financial-control policy threshold boundaries determine matching action", () => {
  const decision = resolveFinancialControlPolicyDecision({
    finding: { ...finding, variance_percent: 75 },
    policies: [
      { id: "ack", org_id: "org-a", workflow: "budget_approval", threshold_min: 25, threshold_max: 49.99, action: "REQUIRE_ACKNOWLEDGEMENT" },
      { id: "block", org_id: "org-a", workflow: "budget_approval", threshold_min: 50, action: "BLOCK" },
    ],
  });
  assertEquals(decision.action, "BLOCK");
  assertEquals(decision.blocks, true);
});

Deno.test("no-policy behavior does not silently fail open or fail closed", () => {
  const decision = resolveFinancialControlPolicyDecision({ finding, policies: [] });
  assertEquals(decision.action, null);
  assertEquals(decision.blocks, false);
  assertEquals(decision.snapshot.reason, "NO_POLICY_CONFIGURED");

  const explicit = resolveFinancialControlPolicyDecision({ finding, policies: [], missingPolicyBehavior: "fail_closed" });
  assertEquals(explicit.action, "BLOCK");
  assertEquals(explicit.blocks, true);
});

Deno.test("cross-org policies are not eligible for another org finding", () => {
  const decision = resolveFinancialControlPolicyDecision({
    finding,
    policies: [{ id: "org-b-block", org_id: "org-b", workflow: "budget_approval", action: "BLOCK" }],
  });
  assertEquals(decision.snapshot.matched_policy_id, null);
  assertEquals(decision.snapshot.reason, "NO_POLICY_CONFIGURED");
});

Deno.test("historical policy snapshot remains stable when policy changes later", () => {
  const original = resolveFinancialControlPolicyDecision({
    finding,
    policies: [{ id: "policy-1", org_id: "org-a", action: "BLOCK", reason: "Original policy" }],
    resolvedAt: "2026-08-14T01:00:00Z",
  });
  const changed = resolveFinancialControlPolicyDecision({
    finding,
    policies: [{ id: "policy-1", org_id: "org-a", action: "WARN", reason: "Changed policy" }],
    resolvedAt: "2026-08-15T01:00:00Z",
  });
  assertEquals(original.snapshot.action, "BLOCK");
  assertEquals(original.snapshot.reason, "Original policy");
  assertEquals(changed.snapshot.action, "WARN");
});

Deno.test("override makes budget approval consumer ignore prior block without deleting snapshot", () => {
  assertEquals(findingBlocksBudgetApproval({ policy_decision_snapshot: { action: "BLOCK", blocks: true } }), true);
  assertEquals(findingBlocksBudgetApproval({ policy_decision_snapshot: { action: "BLOCK", blocks: true, override: { allowed: true } } }), false);
});

Deno.test("Priority 5 schema and wiring persist policy decisions and override audit", () => {
  assertStringIncludes(migrationSql, "CREATE TABLE IF NOT EXISTS public.financial_control_policies");
  assertStringIncludes(migrationSql, "policy_decision_snapshot JSONB");
  assertStringIncludes(migrationSql, "policy_override JSONB");
  assertStringIncludes(migrationSql, "CHECK (action IN ('WARN','REQUIRE_ACKNOWLEDGEMENT','REQUIRE_APPROVAL','BLOCK'))");
  assertStringIncludes(runControlsSource, "resolveFinancialControlPolicyDecision");
  assertStringIncludes(runControlsSource, "policy_decision_snapshot");
  assertStringIncludes(commandSource, "overrideFindingPolicyDecision");
  assertStringIncludes(commandSource, "FINANCIAL_FINDING_POLICY_OVERRIDE");
  assertStringIncludes(automationSource, "policy_action");
  assertStringIncludes(automationSource, "policy_blocks");
  assertStringIncludes(budgetReviewSource, "budgetPolicyBlocks.length > 0");
});
