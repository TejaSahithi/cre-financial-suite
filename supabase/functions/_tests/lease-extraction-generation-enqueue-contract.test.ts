// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { normalizeLeaseExtractionGenerationResult } from "../_shared/extraction/lease-extraction-queue.ts";

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