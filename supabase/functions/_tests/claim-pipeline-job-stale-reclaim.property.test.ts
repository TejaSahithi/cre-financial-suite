// @ts-nocheck
// Property tests against a real local Postgres for claim_pipeline_job's
// lightweight stale-job reclaim (20260866000000). Proves: a fresh 'running'
// job is NOT reclaimable (a genuinely active worker must not be double-
// claimed); a stale 'running' job (updated_at older than the threshold) IS
// reclaimable, with attempt incremented like any other claim; the ordinary
// 'queued' claim path is unaffected.
//
// Run: deno test --allow-all --no-check claim-pipeline-job-stale-reclaim.property.test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

async function setupOrgAndUpload(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Stale Reclaim Org ${suffix}`,
    status: "active",
    primary_contact_email: `stale-reclaim-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `stale-reclaim-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
  });
  return { org, uploadedFile };
}

async function insertJob(
  admin: ReturnType<typeof adminClient>,
  org: any,
  uploadedFile: any,
  overrides: Record<string, unknown>,
) {
  return insertOne(admin, "pipeline_jobs", {
    org_id: org.id,
    uploaded_file_id: uploadedFile.id,
    generation_id: crypto.randomUUID(),
    job_type: "lease_extraction",
    stage: "parse",
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    available_at: new Date().toISOString(),
    ...overrides,
  });
}

Deno.test("claim_pipeline_job: a fresh 'running' job (updated_at just now) is NOT reclaimable", async () => {
  const admin = adminClient();
  const { org, uploadedFile } = await setupOrgAndUpload(admin, `fresh-${Date.now()}`);
  const job = await insertJob(admin, org, uploadedFile, {
    status: "running",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt: 1,
  });

  const { data, error } = await admin.rpc("claim_pipeline_job", { p_job_id: job.id, p_worker_name: "test-worker-2" });
  assertNoError(error);
  assertEquals(data, null);
});

Deno.test("claim_pipeline_job: a stale 'running' job (updated_at 15 minutes old) IS reclaimable, attempt increments", async () => {
  const admin = adminClient();
  const { org, uploadedFile } = await setupOrgAndUpload(admin, `stale-${Date.now()}`);
  const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const job = await insertJob(admin, org, uploadedFile, {
    status: "running",
    started_at: staleTimestamp,
    updated_at: staleTimestamp,
    attempt: 1,
    worker_name: "crashed-worker-1",
  });

  const { data, error } = await admin.rpc("claim_pipeline_job", { p_job_id: job.id, p_worker_name: "recovering-worker" });
  assertNoError(error);
  assertExists(data);
  assertEquals(data.status, "running");
  assertEquals(data.attempt, 2);
  assertEquals(data.worker_name, "recovering-worker");
});

Deno.test("claim_pipeline_job: stale reclaim still respects attempt < max_attempts (exhausted job is not reclaimable)", async () => {
  const admin = adminClient();
  const { org, uploadedFile } = await setupOrgAndUpload(admin, `exhausted-${Date.now()}`);
  const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const job = await insertJob(admin, org, uploadedFile, {
    status: "running",
    started_at: staleTimestamp,
    updated_at: staleTimestamp,
    attempt: 3,
    max_attempts: 3,
  });

  const { data, error } = await admin.rpc("claim_pipeline_job", { p_job_id: job.id, p_worker_name: "recovering-worker" });
  assertNoError(error);
  assertEquals(data, null);
});

Deno.test("claim_pipeline_job: stale reclaim still respects cancel_requested_at (a cancelled stale job is not reclaimable)", async () => {
  const admin = adminClient();
  const { org, uploadedFile } = await setupOrgAndUpload(admin, `cancelled-${Date.now()}`);
  const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const job = await insertJob(admin, org, uploadedFile, {
    status: "running",
    started_at: staleTimestamp,
    updated_at: staleTimestamp,
    attempt: 1,
    cancel_requested_at: new Date().toISOString(),
  });

  const { data, error } = await admin.rpc("claim_pipeline_job", { p_job_id: job.id, p_worker_name: "recovering-worker" });
  assertNoError(error);
  assertEquals(data, null);
});

Deno.test("claim_pipeline_job: ordinary fresh 'queued' claim path is unaffected by the stale-reclaim change", async () => {
  const admin = adminClient();
  const { org, uploadedFile } = await setupOrgAndUpload(admin, `queued-${Date.now()}`);
  // available_at set a few seconds in the past rather than exactly "now" --
  // avoids any host/container clock-precision sensitivity right at the
  // available_at &lt;= now() boundary when insert and claim happen within
  // milliseconds of each other (a real queued job is never claimed that
  // instantaneously in production; the RPC's boundary behavior itself is
  // already covered directly via the stale-reclaim cases above).
  const job = await insertJob(admin, org, uploadedFile, {
    available_at: new Date(Date.now() - 5_000).toISOString(),
  });

  const { data, error } = await admin.rpc("claim_pipeline_job", { p_job_id: job.id, p_worker_name: "worker-1" });
  assertNoError(error);
  assertExists(data);
  assertEquals(data.status, "running");
  assertEquals(data.attempt, 1);
});
