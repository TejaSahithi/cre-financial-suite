// Feature: enterprise-readiness-hardening Phase HARD-2D
// (uploaded_files DELETE RLS lockdown). Property: uploaded_files_delete now
// rejects direct authenticated DELETE (USING (false)) for both org admins
// and non-admin writers, while SELECT/INSERT/UPDATE remain exactly as
// before, and delete_uploaded_file_workflow (which always writes via the
// service-role client, and service_role has rolbypassrls = true) continues
// to work end-to-end unaffected -- for both an allowed (unconsumed) delete
// and a blocked (evidence-linked) one. RPC-level regression for
// delete_uploaded_file_workflow is covered by its own dedicated test file
// (delete-uploaded-file.property.test.ts) -- re-run alongside this one as
// the proof that this migration doesn't break it.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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

async function createOrgUser(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `uploaded-files-rls-${suffix}@example.test`;
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
    full_name: "Uploaded Files RLS Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  return { userId, email, accessToken, asUser };
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

function callDeleteFn(accessToken: string, body: Record<string, unknown>) {
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

Deno.test({
  name: "uploaded_files RLS lockdown: direct authenticated DELETE is rejected for an org admin; SELECT/INSERT/UPDATE unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Org ${suffix}`,
      status: "active",
    });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "org_admin");
    const file = await insertUploadedFile(admin, org);

    // --- Direct authenticated DELETE is rejected (org admin) ---
    const { data: deleteData, error: deleteError } = await asUser
      .from("uploaded_files")
      .delete()
      .eq("id", file.id)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: fileAfterDelete } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfterDelete, "the file must survive the rejected direct DELETE attempt");

    // --- SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("uploaded_files")
      .select("id, file_name")
      .eq("id", file.id)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(selectRow.file_name, "test-lease.pdf");

    // --- INSERT still works (unchanged policy: can_write_org_data) ---
    const { data: insertedRow, error: insertError } = await asUser
      .from("uploaded_files")
      .insert({
        org_id: org.id,
        module_type: "lease",
        file_name: "second-upload.pdf",
        file_url: "https://example.test/second-upload.pdf",
        status: "uploaded",
      })
      .select("*")
      .single();
    assertNoError(insertError);
    assertExists(insertedRow);

    // --- UPDATE still works (unchanged policy: can_write_org_data) ---
    const { data: updateRow, error: updateError } = await asUser
      .from("uploaded_files")
      .update({ status: "parsed" })
      .eq("id", file.id)
      .select("*")
      .single();
    assertNoError(updateError);
    assertEquals(updateRow.status, "parsed");
  },
});

Deno.test({
  name: "uploaded_files RLS lockdown: direct authenticated DELETE is rejected for a non-admin writer too",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Non-Admin Org ${suffix}`,
      status: "active",
    });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "manager");
    const file = await insertUploadedFile(admin, org);

    const { data: deleteData, error: deleteError } = await asUser
      .from("uploaded_files")
      .delete()
      .eq("id", file.id)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive the rejected direct DELETE attempt");
  },
});

Deno.test({
  name: "uploaded_files RLS lockdown: cross-org SELECT remains blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const ownerOrg = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Owner Org ${suffix}`,
      status: "active",
    });
    const outsiderOrg = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Outsider Org ${suffix}`,
      status: "active",
    });
    const { asUser: outsiderClient } = await createOrgUser(admin, `${suffix}-outsider`, outsiderOrg.id, "org_admin");
    const file = await insertUploadedFile(admin, ownerOrg);

    const { data: outsiderRows, error: outsiderError } = await outsiderClient
      .from("uploaded_files")
      .select("id")
      .eq("id", file.id);
    assertNoError(outsiderError);
    assertEquals(outsiderRows?.length ?? 0, 0, "a user outside the org must see zero rows");
  },
});

Deno.test({
  name: "uploaded_files RLS lockdown: delete_uploaded_file_workflow still succeeds via service_role for an allowed (unconsumed) file, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Workflow Allow Org ${suffix}`,
      status: "active",
    });
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
    const file = await insertUploadedFile(admin, org);

    const res = await callDeleteFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertEquals(fileAfter, null, "the file row must be gone");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "UploadedFile")
      .eq("entity_id", file.id)
      .eq("action", "uploaded_file_deleted");
    assertEquals(auditRows?.length, 1, `expected exactly one audit row: ${JSON.stringify(auditRows)}`);
  },
});

Deno.test({
  name: "uploaded_files RLS lockdown: delete_uploaded_file_workflow still blocks a consumed/evidence-linked file, zero audit rows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Uploaded Files RLS Workflow Block Org ${suffix}`,
      status: "active",
    });
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Uploaded Files RLS Workflow Block Property ${suffix}`,
      status: "active",
    });
    const file = await insertUploadedFile(admin, org, { property_id: property.id });
    await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      source_file_id: file.id,
    });

    const res = await callDeleteFn(accessToken, { file_id: file.id });
    const body = await res.json();
    assertEquals(body.error, true, `expected block: ${JSON.stringify(body)}`);
    assertEquals(res.status, 409, JSON.stringify(body));
    assertEquals(body.message, "This upload is already linked to lease evidence and cannot be deleted.");

    const { data: fileAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id).maybeSingle();
    assertExists(fileAfter, "the file must survive a blocked workflow delete");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "UploadedFile")
      .eq("entity_id", file.id)
      .eq("action", "uploaded_file_deleted");
    assertEquals(auditRows?.length ?? 0, 0, "a blocked workflow delete must write zero audit rows");
  },
});
