import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildBlockedReviewPayload,
  countTextChars,
  isBlockingParserStatus,
  MIN_LEASE_TEXT_CHARS,
  parserStatusForTextLength,
  PARSER_STATUSES,
  REVIEW_STATUSES,
} from "../_shared/extraction/pipeline-contract.ts";

Deno.test("pipeline contract classifies empty and insufficient parser text", () => {
  assertEquals(MIN_LEASE_TEXT_CHARS, 500);
  assertEquals(countTextChars("   \n\t  "), 0);
  assertEquals(parserStatusForTextLength(0), PARSER_STATUSES.EMPTY_TEXT);
  assertEquals(parserStatusForTextLength(499), PARSER_STATUSES.INSUFFICIENT_TEXT);
  assertEquals(parserStatusForTextLength(500), PARSER_STATUSES.COMPLETED);
});

Deno.test("pipeline contract marks only terminal parser failures as blocking", () => {
  assertEquals(isBlockingParserStatus(PARSER_STATUSES.EMPTY_TEXT), true);
  assertEquals(isBlockingParserStatus(PARSER_STATUSES.INSUFFICIENT_TEXT), true);
  assertEquals(isBlockingParserStatus(PARSER_STATUSES.FAILED), true);
  assertEquals(isBlockingParserStatus(PARSER_STATUSES.TIMEOUT), true);
  assertEquals(isBlockingParserStatus(PARSER_STATUSES.COMPLETED), false);
});

Deno.test("blocked review payload contains no review records or fake standard fields", () => {
  const payload = buildBlockedReviewPayload({
    fileId: "file-1",
    fileName: "lease.pdf",
    moduleType: "leases",
    documentSubtype: "base_lease",
    extractionMethod: "pdf_text",
    message: "The document could not be parsed into readable lease text.",
    pipeline: {
      parser_status: PARSER_STATUSES.EMPTY_TEXT,
      review_status: REVIEW_STATUSES.BLOCKED,
      error_code: "EMPTY_PARSE_TEXT",
      error_message: "The document could not be parsed into readable lease text.",
      full_text_chars: 0,
      page_count: null,
    },
  });

  assertEquals(payload.records, []);
  assertEquals(payload.rows, []);
  assertEquals(payload.review_status, REVIEW_STATUSES.BLOCKED);
  assertEquals(payload.metadata.pipeline.parser_status, PARSER_STATUSES.EMPTY_TEXT);
  assertEquals(payload.metadata.pipeline.full_text_chars, 0);
});
