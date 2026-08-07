import { describe, expect, it } from "vitest";
import { buildBulkApprovalState } from "@/components/lease-review/utils/bulkApproval";
import { REVIEW_STATUSES } from "@/lib/leaseReviewSchema";

describe("buildBulkApprovalState", () => {
  it("stores the normalized review-row value and evidence for bulk-accepted dates", () => {
    const rowByKey = new Map([
      ["commencement_date", {
        key: "commencement_date",
        normalized_value: "2026-03-01",
        raw_value: "March 1, 2026",
        source_page: 7,
        source_text: "The term shall commence on March 1, 2026.",
        extraction_status: "extracted",
        confidence: 98,
      }],
    ]);

    const result = buildBulkApprovalState({
      eligibleFields: ["commencement_date"],
      fieldReviews: {},
      lease: {
        extraction_data: {
          fields: {
            commencement_date: {
              value: "March 1, 2026",
            },
          },
        },
      },
      rowByKey,
      signedBy: "Reviewer",
      nowIso: "2026-08-07T12:00:00.000Z",
      reviewStatuses: REVIEW_STATUSES,
    });

    expect(result.nextFieldReviews.commencement_date).toMatchObject({
      status: REVIEW_STATUSES.ACCEPTED,
      value: "2026-03-01",
      raw_value: "March 1, 2026",
      source_page: 7,
      source_text: "The term shall commence on March 1, 2026.",
      extraction_status: "extracted",
      confidence: 98,
      confidence_score: 98,
    });
    expect(result.auditDetails[0]).toMatchObject({
      field_key: "commencement_date",
      value: "2026-03-01",
      source_page: 7,
    });
  });

  it("resolves alias rows so accepted start_date inherits the canonical commencement row", () => {
    const reviewRowByKey = new Map([
      ["commencement_date", {
        key: "commencement_date",
        normalized_value: "2026-04-15",
        source_page: 2,
        source_text: "Commencement Date: April 15, 2026",
      }],
    ]);

    const result = buildBulkApprovalState({
      eligibleFields: ["start_date"],
      fieldReviews: {},
      lease: {},
      rowByKey: reviewRowByKey,
      signedBy: "Reviewer",
      nowIso: "2026-08-07T12:00:00.000Z",
      reviewStatuses: REVIEW_STATUSES,
    });

    expect(result.nextFieldReviews.start_date).toMatchObject({
      status: REVIEW_STATUSES.ACCEPTED,
      value: "2026-04-15",
      source_page: 2,
      source_text: "Commencement Date: April 15, 2026",
    });
  });
});
