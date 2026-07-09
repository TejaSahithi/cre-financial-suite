// Feature: enterprise-readiness-hardening Phase HARD-2 / HARD-2B / HARD-2C
// (delete_uploaded_file_workflow). Server-owns LeaseUpload.jsx's
// handleDeleteUpload() action and Documents.jsx's row-level delete action --
// both confirmed reachable, direct-write call sites for the same table.
// Properties:
//   1. A valid (unlinked) delete succeeds, exactly one audit row with a
//      full "before" snapshot.
//   2. A cross-org file_id is rejected, zero side effects.
//   3. A user without page access (viewer) is blocked, zero side effects.
//   4. An unknown/already-deleted file_id is rejected with a clear
//      "not found" error (deliberate: closes the latent silent-no-op gap
//      the raw .delete() had, matching every other delete/update RPC this
//      session).
//   5. A non-admin org member who otherwise has LeaseUpload write access is
//      still blocked -- the RPC re-derives is_org_admin(org_id), preserving
//      the current uploaded_files_delete RLS policy's stricter bar rather
//      than the broader can_write_org_data used by insert/update.
//   6. (HARD-2C, supersedes the original HARD-2 permissive decision)
//      Deleting a file that is a lease's source_file_id is now BLOCKED with
//      the exact user-facing message "This upload is already linked to
//      lease evidence and cannot be deleted.", HTTP 409, zero audit rows,
//      and the lease/file both survive unchanged.
//   7. A pipeline_jobs row referencing the file does NOT block deletion
//      (pipeline_jobs/pipeline_logs completed/success state is disposable
//      processing bookkeeping, not evidence of downstream consumption --
//      see the HARD-2C migration header for the full reasoning) and is
//      still cascade-deleted by the FK constraint itself when the delete
//      is otherwise allowed.
//   8. (HARD-2B) A member whose page_permissions grant write ONLY to
//      "Documents" (explicitly "none" on "LeaseUpload") can still delete --
//      proves the edge function's assertPageAccess recognizes "Documents"
//      as its own valid page name, not just an incidental pass-through.
//   9. (HARD-2B) A member whose page_permissions grant write ONLY to
//      "LeaseUpload" (explicitly "none" on "Documents") can still delete --
//      the symmetric case, confirming neither page name alone is required.
//   10. (HARD-2C) lease_amendments.source_file_id linkage blocks deletion.
//   11. (HARD-2C) lease_assignments.source_file_id linkage blocks deletion.
//   12. (HARD-2C) compute_runs.source_file_id linkage blocks deletion.
//   13. (HARD-2C) document_links (any entity_type) linkage blocks deletion.
//   14. (HARD-2C) A lease whose typed source_file_id is NULL but whose
//       extraction_data->>'source_file_id' matches the file still blocks
//       deletion -- proves the JSONB fallback path (used live by the
//       frontend) is checked, not just the typed column.
//   15. (HARD-2C) An allowed (unlinked) delete still writes exactly one
//       audit row -- re-confirms property 1 survives the new blocking
//       logic being added ahead of the DELETE/INSERT statements.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

async function createOrgUser(
  admin: ReturnType<typeof adminClient>,
  suffix: string,
  orgId: string,
  role: string,
  pagePermissions: Record<string, string> | null = null,
) {
  const email = `delete-uploaded-file-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: "Delete Uploaded File Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
    ...(pagePermissions ? { page_permissions: pagePermissions } : {}),
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, email, accessToken };
}

function callFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/delete-uploaded-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string, role = "org_admin") {
  const org = await insertOne(admin, "organizations", {
    name: `Delete Uploaded File Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, role);

  return { org, accessToken };
}

async function insertUploadedFile(admin: ReturnType<typeof adminClient>, org: { id: string }, overrides: Record<string, unknown> = {}) {
  return insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "lease",
    file_name: "test-lease.pdf",
    file_url: "https://example.test/test-lease.pdf",
    status: "uploaded",
    ...overrides,
  });
}

Deno.test({
  name: "delete_uploaded_file_workflow: valid delete succeeds, exactly one audit row with before snapshot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.error, false);
    assertEquals(body.deleted_id, file.id);
    assertEquals(body.deleted_count, 1);

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertEquals(fileAfter, null, "the file row must be gone");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "UploadedFile")
      .eq("entity_id", file.id)
      .eq("action", "uploaded_file_deleted");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, `expected exactly one audit row: ${JSON.stringify(auditRows)}`);
    assertEquals(auditRows![0].before?.id, file.id);
    assertEquals(auditRows![0].after, null);
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: cross-org file_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org: ownerOrg } = await setUpScope(admin, `${suffix}-owner`);
    const { accessToken: outsiderToken } = await setUpScope(admin, `${suffix}-outsider`);
    const file = await insertUploadedFile(admin, ownerOrg);

    const res = await callFn(outsiderToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected rejection: ${JSON.stringify(body)}`);
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a cross-org delete attempt");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: user without page access (viewer) is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Delete Uploaded File Viewer Org ${suffix}`,
      status: "active",
    });
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(viewerToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the blocked attempt must not delete the row");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: unknown file_id is rejected with a clear not-found error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { file_id: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown file_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: non-admin org member is blocked (org-admin-only bar preserved from current RLS)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Delete Uploaded File Manager Org ${suffix}`,
      status: "active",
    });
    const { accessToken: managerToken } = await createOrgUser(admin, `${suffix}-manager`, org.id, "manager");
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(managerToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected non-admin manager to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the blocked attempt must not delete the row");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: deleting a lease's source file is BLOCKED (HARD-2C), exact message, 409, zero audit rows, file+lease survive",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Delete Uploaded File Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org, { property_id: property.id });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      source_file_id: file.id,
      status: "approved",
      abstract_status: "approved",
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected the delete to be blocked: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));
    assertEquals(body.message, "This upload is already linked to lease evidence and cannot be deleted.");

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");

    const { data: leaseAfter } = await admin.from("leases").select("id, source_file_id").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter!.source_file_id, file.id, "source_file_id must be untouched -- the delete never ran");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "UploadedFile")
      .eq("entity_id", file.id)
      .eq("action", "uploaded_file_deleted");
    assertEquals(auditRows?.length ?? 0, 0, "a blocked delete must write zero audit rows");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: a completed pipeline_jobs row does NOT block deletion (HARD-2C decision) and is cascade-deleted by the FK, not a manual statement in this RPC",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const file = await insertUploadedFile(admin, org);
    const job = await insertOne(admin, "pipeline_jobs", {
      org_id: org.id,
      uploaded_file_id: file.id,
      job_type: "lease_extraction",
      stage: "parse",
      status: "completed",
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: jobAfter } = await admin.from("pipeline_jobs").select("id").eq("id", job.id).maybeSingle();
    assertEquals(jobAfter, null, "pipeline_jobs row must be cascade-deleted by the FK");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: a member with write access to ONLY the Documents page can still delete (HARD-2B)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Delete Uploaded File Documents-Only Org ${suffix}`,
      status: "active",
    });
    const { accessToken } = await createOrgUser(admin, `${suffix}-docs-only`, org.id, "manager", {
      Documents: "write",
      LeaseUpload: "none",
    });
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    // A "manager" role is still blocked by the RPC's own org-admin-only
    // check (property 5) -- this test proves the page-access LAYER
    // recognizes "Documents", by confirming the failure is the RPC's
    // admin-only message, not an access-denied/401/403 from assertPageAccess.
    assertEquals(body.error, true);
    assertEquals(/only organization admins/i.test(body.message || ""), true, `expected the page-access check to pass and the RPC's own admin check to be what blocks this call: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: an org admin with write access to ONLY the Documents page can fully complete a delete (HARD-2B)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Delete Uploaded File Documents-Only Admin Org ${suffix}`,
      status: "active",
    });
    const { accessToken } = await createOrgUser(admin, `${suffix}-docs-only-admin`, org.id, "org_admin", {
      Documents: "write",
      LeaseUpload: "none",
    });
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success via Documents-only page access: ${JSON.stringify(body)}`);
    assertEquals(body.deleted_id, file.id);

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertEquals(fileAfter, null, "the file row must be gone");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: an org admin with write access to ONLY the LeaseUpload page can fully complete a delete (symmetric case)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Delete Uploaded File LeaseUpload-Only Admin Org ${suffix}`,
      status: "active",
    });
    const { accessToken } = await createOrgUser(admin, `${suffix}-lu-only-admin`, org.id, "org_admin", {
      Documents: "none",
      LeaseUpload: "write",
    });
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success via LeaseUpload-only page access: ${JSON.stringify(body)}`);
    assertEquals(body.deleted_id, file.id);
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: lease_amendments.source_file_id linkage blocks deletion (HARD-2C)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `HARD-2C Amendments Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org, { property_id: property.id });
    const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id });
    await insertOne(admin, "lease_amendments", {
      org_id: org.id,
      lease_id: lease.id,
      source_file_id: file.id,
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));
    assertEquals(body.message, "This upload is already linked to lease evidence and cannot be deleted.");

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: lease_assignments.source_file_id linkage blocks deletion (HARD-2C)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `HARD-2C Assignments Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org, { property_id: property.id });
    const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id });
    await insertOne(admin, "lease_assignments", {
      org_id: org.id,
      lease_id: lease.id,
      source_file_id: file.id,
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: compute_runs.source_file_id linkage blocks deletion (HARD-2C)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const file = await insertUploadedFile(admin, org);
    await insertOne(admin, "compute_runs", {
      org_id: org.id,
      engine_type: "lease",
      input_fingerprint: `fingerprint-${suffix}`,
      status: "completed",
      source_file_id: file.id,
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: document_links linkage (any entity_type) blocks deletion (HARD-2C)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `HARD-2C Document Links Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org);
    await insertOne(admin, "document_links", {
      org_id: org.id,
      file_id: file.id,
      entity_type: "property",
      entity_id: property.id,
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: extraction_data->>'source_file_id' fallback (typed column NULL) blocks deletion (HARD-2C)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `HARD-2C Extraction Data Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org, { property_id: property.id });
    // Typed source_file_id left NULL deliberately -- only the JSONB fallback
    // path carries the reference, matching how the frontend itself falls
    // back (lease.source_file_id ?? lease.extraction_data?.source_file_id).
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      source_file_id: null,
      extraction_data: { source_file_id: file.id },
    });

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block via extraction_data fallback: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked delete");

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertExists(leaseAfter, "the lease is untouched");
  },
});

Deno.test({
  name: "delete_uploaded_file_workflow: an allowed (unlinked) delete still writes exactly one audit row (HARD-2C regression check)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);
    const file = await insertUploadedFile(admin, org);

    const res = await callFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "UploadedFile")
      .eq("entity_id", file.id)
      .eq("action", "uploaded_file_deleted");
    assertEquals(auditRows?.length, 1, `expected exactly one audit row: ${JSON.stringify(auditRows)}`);
  },
});
