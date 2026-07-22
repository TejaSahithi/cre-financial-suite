import { describe, expect, it } from "vitest";
import { validateReviewFieldAction } from "@/lib/review/useReviewFieldActions";

describe("review field action validation", () => {
  it("accepts field acceptance without a reason", () => {
    expect(validateReviewFieldAction({ type: "accept", fieldKey: "tenant_name" })).toBeNull();
  });

  it("requires reasons for reviewer override decisions", () => {
    expect(validateReviewFieldAction({ type: "override", fieldKey: "tenant_name", value: "Acme" })).toMatch(/reason/i);
    expect(validateReviewFieldAction({ type: "clear", fieldKey: "tenant_name" })).toMatch(/reason/i);
    expect(validateReviewFieldAction({ type: "not_applicable", fieldKey: "tenant_name" })).toMatch(/reason/i);
    expect(validateReviewFieldAction({ type: "follow_up", fieldKey: "tenant_name" })).toMatch(/reason/i);
  });

  it("requires override values", () => {
    expect(validateReviewFieldAction({ type: "override", fieldKey: "tenant_name", reason: "Corrected" })).toMatch(/value/i);
  });
});