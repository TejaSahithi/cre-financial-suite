import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Phase 5E integration requires SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in the environment");
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function authenticatedClient(accessToken) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function assertNoError(error, label) {
  if (error) throw new Error(`${label}: ${error.message || JSON.stringify(error)}`);
}

async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  await assertNoError(error, `insert ${table}`);
  expect(data?.id, `inserted ${table} id`).toBeTruthy();
  return data;
}

async function createOrgUser(admin, { suffix, orgId }) {
  const email = `phase5e-${suffix}@example.test`;
  const password = `Phase5e-${suffix}!Aa1`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  await assertNoError(userError, "create user");
  const userId = userData.user?.id;
  expect(userId).toBeTruthy();

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: "Phase 5E Package Reviewer",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role: "org_admin",
    status: "active",
    page_permissions: {
      LeaseUpload: "admin",
      LeaseReview: "admin",
      Leases: "admin",
    },
    module_permissions: {},
    capabilities: {},
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  await assertNoError(signInError, "sign in user");
  const accessToken = signInData.session?.access_token;
  expect(accessToken).toBeTruthy();
  return { userId, email, accessToken };
}

function uploadSubtypeForProfile(profile) {
  if (profile === "lease_amendment" || profile === "renewal_amendment") return "amendment";
  if (profile === "assignment_assumption") return "assignment";
  if (profile === "exhibit") return "addendum";
  return profile;
}

async function createUploadedFile(admin, { orgId, actorId, suffix, profile, index }) {
  return insertOne(admin, "uploaded_files", {
    org_id: orgId,
    module_type: "leases",
    file_name: `phase5e-${index}-${profile}-${suffix}.pdf`,
    file_url: `local://phase5e/${suffix}/${index}.pdf`,
    file_size: 1024 + index,
    mime_type: "application/pdf",
    uploaded_by: actorId,
    status: "completed",
    processing_status: "completed",
    extraction_method: "phase5e_seeded_local_fixture",
    document_subtype: uploadSubtypeForProfile(profile),
    review_required: false,
    review_status: "not_required",
    normalized_output: {
      metadata: {
        phase: "5E",
        sanitized: true,
        provider_execution: false,
      },
    },
    ui_review_payload: {
      metadata: {
        phase: "5E",
        sanitized: true,
      },
    },
  });
}

async function createRun(admin, { orgId, upload, leaseId = null, profile, suffix }) {
  return insertOne(admin, "document_intelligence_runs", {
    org_id: orgId,
    uploaded_file_id: upload.id,
    lease_id: leaseId,
    contract_version: "document_intelligence_v3.phase5e.seeded",
    idempotency_key: `phase5e-${suffix}-${upload.id}`,
    status: "completed",
    profile_key: profile,
    profile_confidence: 0.99,
    profile_status: "manual_override",
    version_metadata: {
      phase: "5E",
      provider_execution: false,
    },
    coverage: {},
    readiness: {},
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
}

async function upsertPackage(admin, { orgId, packageKey, primaryUploadId, leaseId = null }) {
  const { data, error } = await admin
    .from("document_packages")
    .upsert({
      org_id: orgId,
      package_key: packageKey,
      package_type: "lease_package",
      display_name: "Phase 5E seeded local package",
      primary_uploaded_file_id: primaryUploadId,
      primary_lease_id: leaseId,
      metadata: {
        phase: "5E",
        diagnostic_only: true,
        seeded_local: true,
      },
    }, { onConflict: "org_id,package_key" })
    .select("*")
    .single();
  await assertNoError(error, "upsert document_packages");
  return data;
}

async function upsertPackageDocument(admin, { orgId, packageId, upload, run, leaseId = null, profile, type, effectiveDate, index }) {
  const { data, error } = await admin
    .from("document_package_documents")
    .upsert({
      org_id: orgId,
      package_id: packageId,
      uploaded_file_id: upload.id,
      lease_id: leaseId,
      document_intelligence_run_id: run.id,
      document_profile: profile,
      document_type: type,
      file_name: upload.file_name,
      effective_date: effectiveDate,
      is_primary: index === 0,
      confidence: 0.99,
      metadata: {
        phase: "5E",
        diagnostic_only: true,
        seeded_local: true,
      },
    }, { onConflict: "org_id,package_id,document_intelligence_run_id" })
    .select("*")
    .single();
  await assertNoError(error, "upsert document_package_documents");
  return data;
}

async function seedPackage(admin, { orgId, actorId, suffix }) {
  const lease = await insertOne(admin, "leases", {
    org_id: orgId,
    tenant_name: "Cress Family Restaurants, LLC",
    start_date: "2019-03-01",
    end_date: "2029-02-28",
    status: "active",
    abstract_status: "draft",
    extraction_data: {
      phase: "5E",
      sanitized: true,
      fields: {
        tenant_name: { value: "Cress Family Restaurants, LLC" },
        monthly_rent: { value: 20000 },
      },
    },
  });

  const specs = [
    ["base_lease", "base_lease", "2019-03-01"],
    ["lease_amendment", "amendment", "2024-01-01"],
    ["assignment_assumption", "assignment", "2025-06-01"],
    ["lease_amendment", "amendment", "2026-01-01"],
    ["renewal_amendment", "amendment", "2029-03-01"],
    ["exhibit", "exhibit", "2019-03-01"],
  ];

  const uploads = [];
  for (let index = 0; index < specs.length; index += 1) {
    const [profile, type, effectiveDate] = specs[index];
    const upload = await createUploadedFile(admin, { orgId, actorId, suffix, profile, index });
    const run = await createRun(admin, { orgId, upload, leaseId: lease.id, profile, suffix });
    uploads.push({ upload, run, profile, type, effectiveDate, index });
  }

  const packageKey = `lease:${lease.id}`;
  const firstPackage = await upsertPackage(admin, {
    orgId,
    packageKey,
    primaryUploadId: uploads[0].upload.id,
    leaseId: lease.id,
  });
  const repeatedPackage = await upsertPackage(admin, {
    orgId,
    packageKey,
    primaryUploadId: uploads[0].upload.id,
    leaseId: lease.id,
  });
  expect(repeatedPackage.id).toBe(firstPackage.id);

  const docs = [];
  for (const item of uploads) {
    const doc = await upsertPackageDocument(admin, {
      orgId,
      packageId: firstPackage.id,
      upload: item.upload,
      run: item.run,
      leaseId: lease.id,
      profile: item.profile,
      type: item.type,
      effectiveDate: item.effectiveDate,
      index: item.index,
    });
    docs.push(doc);
  }

  await upsertPackageDocument(admin, {
    orgId,
    packageId: firstPackage.id,
    upload: uploads[1].upload,
    run: uploads[1].run,
    leaseId: lease.id,
    profile: uploads[1].profile,
    type: uploads[1].type,
    effectiveDate: uploads[1].effectiveDate,
    index: 1,
  });

  const { data: requirement, error: requirementError } = await admin
    .from("document_related_document_requirements")
    .upsert({
      org_id: orgId,
      package_id: firstPackage.id,
      source_document_id: docs[1].id,
      required_document_type: "original_lease",
      reason: "Phase 5E seeded amendment requires original lease context.",
      required_for: ["current_truth"],
      importance_level: "high",
      status: "linked",
      candidate_document_ids: [docs[0].id],
      metadata: { phase: "5E", diagnostic_only: true },
    }, { onConflict: "org_id,package_id,source_document_id,required_document_type,reason" })
    .select("*")
    .single();
  await assertNoError(requirementError, "upsert document_related_document_requirements");

  const { data: relationship, error: relationshipError } = await admin
    .from("document_relationships")
    .upsert({
      org_id: orgId,
      package_id: firstPackage.id,
      source_document_id: docs[1].id,
      target_document_id: docs[0].id,
      target_document_requirement_id: requirement.id,
      relationship_type: "original_lease_for",
      confidence: 0.99,
      evidence_claim_ids: [],
      evidence_summary: { phase: "5E", sanitized: true },
      status: "confirmed",
      metadata: { phase: "5E", diagnostic_only: true },
    }, { onConflict: "org_id,package_id,source_document_id,relationship_type,target_document_id,target_document_requirement_id" })
    .select("*")
    .single();
  await assertNoError(relationshipError, "upsert document_relationships");

  return { lease, packageRow: firstPackage, docs, requirement, relationship };
}

describe("Phase 5E authenticated package current-truth validation", () => {
  it("keeps package rows idempotent, org-scoped, and server-owned under local RLS", async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);

    const orgA = await insertOne(admin, "organizations", { name: `Phase 5E Org A ${suffix}`, status: "active" });
    const orgB = await insertOne(admin, "organizations", { name: `Phase 5E Org B ${suffix}`, status: "active" });
    const userA = await createOrgUser(admin, { suffix: `${suffix}-a`, orgId: orgA.id });
    const userB = await createOrgUser(admin, { suffix: `${suffix}-b`, orgId: orgB.id });

    const fixture = await seedPackage(admin, { orgId: orgA.id, actorId: userA.userId, suffix });

    const { count: packageCount, error: packageCountError } = await admin
      .from("document_packages")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgA.id)
      .eq("package_key", fixture.packageRow.package_key);
    await assertNoError(packageCountError, "count document_packages");
    expect(packageCount).toBe(1);

    const { count: documentCount, error: documentCountError } = await admin
      .from("document_package_documents")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgA.id)
      .eq("package_id", fixture.packageRow.id);
    await assertNoError(documentCountError, "count document_package_documents");
    expect(documentCount).toBe(6);

    const clientA = authenticatedClient(userA.accessToken);
    const clientB = authenticatedClient(userB.accessToken);

    const { data: visibleToA, error: visibleToAError } = await clientA
      .from("document_package_documents")
      .select("id, uploaded_file_id, document_profile, effective_date")
      .eq("package_id", fixture.packageRow.id)
      .order("effective_date", { ascending: true });
    await assertNoError(visibleToAError, "org A package document select");
    expect(visibleToA).toHaveLength(6);
    expect(new Set(visibleToA.map((row) => row.uploaded_file_id)).size).toBe(6);
    expect(visibleToA.map((row) => row.document_profile)).toEqual(expect.arrayContaining([
      "base_lease",
      "lease_amendment",
      "assignment_assumption",
      "renewal_amendment",
      "exhibit",
    ]));

    const { data: visibleToB, error: visibleToBError } = await clientB
      .from("document_package_documents")
      .select("id")
      .eq("package_id", fixture.packageRow.id);
    await assertNoError(visibleToBError, "org B package document select");
    expect(visibleToB).toHaveLength(0);

    const { data: relationshipsForA, error: relationshipsForAError } = await clientA
      .from("document_relationships")
      .select("id, relationship_type, status")
      .eq("package_id", fixture.packageRow.id);
    await assertNoError(relationshipsForAError, "org A relationship select");
    expect(relationshipsForA).toEqual([
      expect.objectContaining({ relationship_type: "original_lease_for", status: "confirmed" }),
    ]);

    const { data: relationshipsForB, error: relationshipsForBError } = await clientB
      .from("document_relationships")
      .select("id")
      .eq("package_id", fixture.packageRow.id);
    await assertNoError(relationshipsForBError, "org B relationship select");
    expect(relationshipsForB).toHaveLength(0);

    const insertAttempt = await clientA
      .from("document_packages")
      .insert({
        org_id: orgA.id,
        package_key: `lease:forbidden-${suffix}`,
        package_type: "lease_package",
      });
    expect(insertAttempt.error, "authenticated package writes must be rejected").toBeTruthy();

    const updateAttempt = await clientA
      .from("document_relationships")
      .update({ status: "rejected" })
      .eq("id", fixture.relationship.id);
    if (updateAttempt.error) {
      expect(String(updateAttempt.error.message || "")).toMatch(/permission|policy|not allowed|violates/i);
    }

    const { data: relationshipAfter, error: relationshipAfterError } = await admin
      .from("document_relationships")
      .select("status")
      .eq("id", fixture.relationship.id)
      .single();
    await assertNoError(relationshipAfterError, "load relationship after authenticated update attempt");
    expect(relationshipAfter.status).toBe("confirmed");
  });
});
