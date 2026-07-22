// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { enqueueEnrichmentJob } from "../_shared/extraction/enrichment-dispatch.ts";

function makeSupabase(result: Record<string, unknown>) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      return Promise.resolve({ data: result, error: null, name, args });
    },
  };
}

function makeLogger(events: Array<Record<string, unknown>>) {
  return {
    event(step: string, level: string, payload: Record<string, unknown>) {
      events.push({ step, level, payload });
      return Promise.resolve();
    },
  };
}

Deno.test("enqueueEnrichmentJob dispatches newly created enrich jobs", async () => {
  const dispatched: string[] = [];
  const events: Array<Record<string, unknown>> = [];

  const result = await enqueueEnrichmentJob({
    supabaseAdmin: makeSupabase({ created: true, job_id: "job-new" }),
    orgId: "org-1",
    fileId: "file-1",
    moduleType: "leases",
    logger: makeLogger(events),
    dispatchWorker: (jobId) => dispatched.push(jobId),
  });

  assertEquals(result, { id: "job-new", existing: false });
  assertEquals(dispatched, ["job-new"]);
  assertEquals(events.map((event) => event.level), ["queued"]);
});

Deno.test("enqueueEnrichmentJob redispatches existing active enrich jobs", async () => {
  const dispatched: string[] = [];
  const events: Array<Record<string, unknown>> = [];

  const result = await enqueueEnrichmentJob({
    supabaseAdmin: makeSupabase({ created: false, existing_job_id: "job-existing" }),
    orgId: "org-1",
    fileId: "file-1",
    moduleType: "leases",
    logger: makeLogger(events),
    dispatchWorker: (jobId) => dispatched.push(jobId),
  });

  assertEquals(result, { id: "job-existing", existing: true });
  assertEquals(dispatched, ["job-existing"]);
  assertEquals(events.map((event) => event.level), ["redispatched"]);
});
