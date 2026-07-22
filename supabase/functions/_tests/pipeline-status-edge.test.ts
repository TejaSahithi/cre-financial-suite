// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  deriveDisplayState,
  isMissingSchemaError,
  sanitizeJob,
  sanitizeLog,
} from "../pipeline-status/status-utils.ts";

Deno.test("pipeline-status identifies missing optional schema errors", () => {
  assertEquals(isMissingSchemaError({ code: "42703", message: "column processing_status does not exist" }), true);
  assertEquals(isMissingSchemaError({ code: "PGRST204", message: "Could not find failed_step in the schema cache" }), true);
  assertEquals(isMissingSchemaError({ code: "23505", message: "duplicate key value violates unique constraint" }), false);
});

Deno.test("pipeline-status maps queued and running jobs to display states", () => {
  assertEquals(
    deriveDisplayState({ status: "uploaded" }, { status: "queued", stage: "parse" }).display_state,
    "queued",
  );
  assertEquals(
    deriveDisplayState({ status: "parsing" }, { status: "running", stage: "parse" }).display_state,
    "parsing",
  );
  assertEquals(
    deriveDisplayState({ status: "pdf_parsed" }, { status: "running", stage: "normalize" }).display_state,
    "normalizing",
  );
});


Deno.test("pipeline-status opens review-required validated files after a completed normalize job", () => {
  const state = deriveDisplayState({
    status: "validated",
    processing_status: "pdf_parsed",
    review_required: true,
  }, {
    status: "completed",
    stage: "normalize",
  });

  assertEquals(state.display_state, "ready_for_review");
  assertEquals(state.next_action, "open_review");
});



Deno.test("pipeline-status does not open non-reviewable validated files", () => {
  const state = deriveDisplayState({
    status: "validated",
    processing_status: "ready_for_review",
    review_required: false,
  }, {
    status: "completed",
    stage: "normalize",
  });

  assertEquals(state.display_state, "complete");
  assertEquals(state.next_action, null);
});

Deno.test("pipeline-status maps parser blocked and failed states clearly", () => {
  assertEquals(
    deriveDisplayState({
      status: "failed",
      processing_status: "parse_completed_empty_text",
      error_message: "The document could not be parsed into readable lease text.",
    }, null).display_state,
    "blocked",
  );
  assertEquals(
    deriveDisplayState({ status: "failed" }, {
      status: "failed",
      stage: "parse",
      error_message: "parse-document-azure returned 401",
    }).display_state,
    "failed",
  );
});

Deno.test("pipeline-status sanitizes job and log payloads", () => {
  const job = sanitizeJob({
    id: "job-1",
    job_type: "lease_extraction",
    status: "failed",
    stage: "parse",
    attempt: 1,
    max_attempts: 3,
    input: { uploaded_file_id: "file-1", signed_url: "https://secret-url" },
    counts: { fields: 3 },
    metadata: { full_text_chars: 1000, source_text: "sensitive text" },
  });
  assertEquals(job.input_summary.type, "object");
  assertEquals(job.counts.fields, 3);
  assertEquals(job.metadata_summary.full_text_chars, 1000);
  assertEquals(job.metadata_summary.source_text.type, "object");

  const log = sanitizeLog({
    step: "parse",
    level: "error",
    message: "Parser failed",
    metadata: { error_code: "PARSE_FAILED", counts: { pages: 0 } },
    timestamp: "2026-06-10T12:00:00Z",
  });
  assertEquals(log.stage, "parse");
  assertEquals(log.status, "error");
  assertEquals(log.error_code, "PARSE_FAILED");
  assertEquals(log.counts.pages, 0);
});