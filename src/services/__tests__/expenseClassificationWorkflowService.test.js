import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeEdgeFunctionMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
}));

vi.mock("@/services/edgeFunctions", () => ({
  invokeEdgeFunction: invokeEdgeFunctionMock,
}));

import {
  createExpenseClassificationCamSendIdempotencyKey,
  sendExpenseClassificationToCam,
} from "../expenseClassificationWorkflowService";

describe("expenseClassificationWorkflowService", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("submits expense classification CAM send intent through the Edge workflow", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      classification: { id: "classification-1", sent_to_cam: true },
      workflow_run_id: "run-1",
    });

    const result = await sendExpenseClassificationToCam({
      classificationId: "classification-1",
      reason: "manual review",
      idempotencyKey: "key-1",
    });

    expect(result.classification.sent_to_cam).toBe(true);
    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("send-expense-classification-to-cam", {
      classification_id: "classification-1",
      reason: "manual review",
      idempotency_key: "key-1",
    });
  });

  it("creates idempotency keys scoped by classification", () => {
    const key = createExpenseClassificationCamSendIdempotencyKey("classification-99");

    expect(key).toContain("expense-classification:send_to_cam:classification-99:");
  });
});
