// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildLeaseExtractionQueuedStatusPatch,
  normalizeLeaseExtractionGenerationResult,
} from "../_shared/extraction/lease-extraction-queue.ts";

Deno.test("lease extraction enqueue contract: accepts only generation-scoped queue results", () => {
  const result = normalizeLeaseExtractionGenerationResult({ job_id: "job-1", generation_id: "generation-1" });

  assertEquals(result, {
    job: { id: "job-1", generationId: "generation-1" },
    error: null,
  });
});

Deno.test("lease extraction enqueue contract: rejects a job result with no generation id", () => {
  const result = normalizeLeaseExtractionGenerationResult({ job_id: "job-1", generation_id: null });

  assertEquals(result, {
    job: null,
    error: "missing generation id",
  });
});

Deno.test("lease extraction enqueue contract: rejects a generation result with no job id", () => {
  const result = normalizeLeaseExtractionGenerationResult({ generation_id: "generation-1" });

  assertEquals(result, {
    job: null,
    error: "missing job id",
  });
});

Deno.test("lease extraction enqueue contract: surfaces database enqueue errors", () => {
  const result = normalizeLeaseExtractionGenerationResult(null, { message: "null value in column generation_id" });

  assertEquals(result, {
    job: null,
    error: "null value in column generation_id",
  });
});
Deno.test("lease extraction enqueue contract: queued lease uploads preserve review requirement", () => {
  assertEquals(buildLeaseExtractionQueuedStatusPatch(), {
    processing_status: "lease_extraction_queued",
    review_required: true,
    review_status: "pending",
    error_message: null,
    failed_step: null,
    processing_completed_at: null,
  });
});

Deno.test("lease extraction enqueue contract: ingest-file always queues lease PDFs through the worker, even when run_synchronously is supplied", async () => {
  const source = await Deno.readTextFile("supabase/functions/ingest-file/index.ts");

  assert(source.includes("if (routing.route === \"parse-document-azure\" && isLeaseModule)"));
  assert(source.includes("routed_to: \"lease-extraction-worker\""));
  assert(source.includes("run_synchronously_ignored: run_synchronously === true"));
  assertEquals(source.includes("isLeaseModule && run_synchronously !== true"), false);
});

Deno.test("lease extraction enqueue contract: direct user parse-document-azure calls are blocked for lease files", async () => {
  const source = await Deno.readTextFile("supabase/functions/parse-document-azure/index.ts");

  assert(source.includes("LEASE_PARSE_REQUIRES_WORKER_PIPELINE"));
  assert(source.includes("isLeaseModule && !requestIsInternal"));
  assert(source.includes("route: \"ingest-file\""));
});
