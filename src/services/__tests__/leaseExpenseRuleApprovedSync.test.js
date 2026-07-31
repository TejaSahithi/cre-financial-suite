import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeEdgeFunctionMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
}));

vi.mock("@/services/edgeFunctions", () => ({
  invokeEdgeFunction: invokeEdgeFunctionMock,
}));

import { leaseExpenseRuleService } from "../leaseExpenseRuleService";

describe("leaseExpenseRuleService approved-only synchronization", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("delegates generation and persistence to the approved-lease server workflow", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      status: "persisted",
      rules_persisted: 6,
    });

    const result = await leaseExpenseRuleService.syncApprovedLeaseExpenseRules({
      leaseId: "11111111-1111-4111-8111-111111111111",
    });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith(
      "sync-approved-lease-expense-rules",
      {
        lease_id: "11111111-1111-4111-8111-111111111111",
        force: false,
      },
    );
    expect(result.rules_persisted).toBe(6);
  });

  it("rejects calls without a lease id before invoking the server", async () => {
    await expect(
      leaseExpenseRuleService.syncApprovedLeaseExpenseRules({}),
    ).rejects.toThrow("leaseId is required");
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});
