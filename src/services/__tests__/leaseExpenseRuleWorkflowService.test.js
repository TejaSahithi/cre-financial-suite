import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeEdgeFunctionMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
}));

vi.mock("@/services/edgeFunctions", () => ({
  invokeEdgeFunction: invokeEdgeFunctionMock,
}));

import {
  approveLeaseExpenseRule,
  createRuleReviewIdempotencyKey,
  markLeaseExpenseRuleNotApplicable,
  publishLeaseExpenseRuleToCam,
  rejectLeaseExpenseRule,
} from "../leaseExpenseRuleWorkflowService";

describe("leaseExpenseRuleWorkflowService", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("submits approve, reject, and not-applicable intent through Edge Functions", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ ok: true });

    await approveLeaseExpenseRule({
      ruleId: "rule-1",
      reason: "accepted clause",
      idempotencyKey: "key-approve",
    });
    await rejectLeaseExpenseRule({
      ruleId: "rule-2",
      reason: "incorrect mapping",
      idempotencyKey: "key-reject",
    });
    await markLeaseExpenseRuleNotApplicable({
      ruleId: "rule-3",
      reason: "explicit exclusion",
      idempotencyKey: "key-na",
    });

    expect(invokeEdgeFunctionMock).toHaveBeenNthCalledWith(1, "approve-lease-expense-rule", {
      rule_id: "rule-1",
      reason: "accepted clause",
      idempotency_key: "key-approve",
    });
    expect(invokeEdgeFunctionMock).toHaveBeenNthCalledWith(2, "reject-lease-expense-rule", {
      rule_id: "rule-2",
      reason: "incorrect mapping",
      idempotency_key: "key-reject",
    });
    expect(invokeEdgeFunctionMock).toHaveBeenNthCalledWith(3, "mark-lease-expense-rule-not-applicable", {
      rule_id: "rule-3",
      reason: "explicit exclusion",
      idempotency_key: "key-na",
    });
  });

  it("submits publish-to-CAM intent through the server workflow", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      rule: { id: "rule-1", published_to_cam: true },
      workflow_run_id: "run-1",
    });

    const result = await publishLeaseExpenseRuleToCam({
      ruleId: "rule-1",
      idempotencyKey: "key-publish",
    });

    expect(result.rule.published_to_cam).toBe(true);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("publish-lease-expense-rule-to-cam", {
      rule_id: "rule-1",
      idempotency_key: "key-publish",
    });
  });

  it("keeps financial workflow idempotency keys scoped by rule and action", () => {
    const key = createRuleReviewIdempotencyKey("rule-99", "publish_to_cam");

    expect(key).toContain("lease-expense-rule:publish_to_cam:rule-99:");
  });
});
