import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Phase 5D integration requires SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in the environment");
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function assertNoError(error, label = "supabase call") {
  if (error) throw new Error(`${label}: ${error.message || JSON.stringify(error)}`);
}

async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  await assertNoError(error, `insert ${table}`);
  expect(data?.id, `inserted ${table} id`).toBeTruthy();
  return data;
}

async function createOrgUser(admin, { suffix, orgId, role = "org_admin" }) {
  const email = `phase5d-${suffix}@example.test`;
  const password = `Phase5d-${suffix}!Aa1`;
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
    full_name: `Phase 5D ${role}`,
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
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

async function callEdge(functionName, accessToken, body, orgId) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      apikey: ANON_KEY,
      "x-acting-org-id": orgId,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function field(fieldKey, value, page = 1) {
  return {
    field_key: fieldKey,
    label: fieldKey.replace(/_/g, " "),
    value,
    original_value: value,
    status: "accepted",
    accepted: true,
    is_standard: true,
    confidence: 0.95,
    evidence: {
      source_page: page,
      source_text: `Sanitized Phase 5D ${fieldKey} clause.`,
    },
  };
}

function reviewPayload({ tenantName, propertyName = "Phase 5D Property", documentProfile = "base_lease" }) {
  const fields = [
    field("tenant_name", tenantName, 1),
    field("property_name", propertyName, 1),
    field("commencement_date", "2026-01-01", 2),
    field("expiration_date", "2030-12-31", 2),
    field("monthly_rent", 12000, 3),
    field("lease_type", "nnn", 3),
  ];
  return {
    records: [{ standard_fields: fields, custom_fields: [] }],
    metadata: {
      phase: "5D",
      sanitized: true,
      workflow_output: {
        document_profile: { documentType: documentProfile },
        selected_document_profile: documentProfile,
        lease_fields: Object.fromEntries(fields.map((item) => [item.field_key, {
          value: item.value,
          source_page: item.evidence.source_page,
          source_text: item.evidence.source_text,
          confidence_score: item.confidence,
          extraction_status: "extracted",
        }])),
        expense_rules: [],
      },
    },
  };
}

async function seedUpload(admin, { orgId, actorId, fileName, tenantName, documentSubtype = "base_lease" }) {
  const payload = reviewPayload({ tenantName, documentProfile: documentSubtype });
  return insertOne(admin, "uploaded_files", {
    org_id: orgId,
    module_type: "leases",
    file_name: fileName,
    file_url: `local://phase5d/${fileName}`,
    file_size: 2048,
    mime_type: "application/pdf",
    uploaded_by: actorId,
    status: "review_required",
    processing_status: "review_required",
    extraction_method: "phase5d_seeded_local_fixture",
    document_subtype: documentSubtype,
    review_required: true,
    review_status: "review_ready",
    normalized_output: { records: payload.records, metadata: payload.metadata },
    ui_review_payload: payload,
    parsed_data: [{ tenant_name: tenantName }],
    docling_raw: { full_text: "Sanitized Phase 5D local fixture text." },
    review_audit: {},
  });
}

async function loadLease(admin, leaseId) {
  const { data, error } = await admin
    .from("leases")
    .select("*")
    .eq("id", leaseId)
    .single();
  await assertNoError(error, "load lease");
  return data;
}

async function prepareLease(accessToken, orgId, fileId) {
  const result = await callEdge("review-approve", accessToken, {
    file_id: fileId,
    action: "prepare",
  }, orgId);
  expect(result.response.status, JSON.stringify(result.payload)).toBe(200);
  const leaseId = result.payload?.store_result?.inserted_ids?.[0];
  expect(leaseId).toBeTruthy();
  return { ...result, leaseId };
}

describe("Phase 5D authenticated source-document linkage integration", () => {
  it("preserves exact upload-to-lease source identity through prepare, retry, repair guard, approval, and amendment separation", async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);

    const org = await insertOne(admin, "organizations", { name: `Phase 5D Org ${suffix}`, status: "active" });
    const actor = await createOrgUser(admin, { suffix: `${suffix}-actor`, orgId: org.id });
    const otherOrg = await insertOne(admin, "organizations", { name: `Phase 5D Other Org ${suffix}`, status: "active" });
    const otherActor = await createOrgUser(admin, { suffix: `${suffix}-other`, orgId: otherOrg.id });

    const uploadA = await seedUpload(admin, {
      orgId: org.id,
      actorId: actor.userId,
      fileName: `phase5d-tenant-lease-a-${suffix}.pdf`,
      tenantName: `Phase 5D Tenant ${suffix}`,
    });
    const uploadB = await seedUpload(admin, {
      orgId: org.id,
      actorId: actor.userId,
      fileName: `phase5d-tenant-lease-b-${suffix}.pdf`,
      tenantName: `Phase 5D Tenant ${suffix}`,
    });
    const otherUpload = await seedUpload(admin, {
      orgId: otherOrg.id,
      actorId: otherActor.userId,
      fileName: `phase5d-cross-org-${suffix}.pdf`,
      tenantName: `Phase 5D Tenant ${suffix}`,
    });

    const firstPrepare = await prepareLease(actor.accessToken, org.id, uploadA.id);
    const leaseId = firstPrepare.leaseId;
    const afterPrepare = await loadLease(admin, leaseId);
    expect(afterPrepare.source_file_id).toBe(uploadA.id);
    expect(afterPrepare.extraction_data.source_file_id).toBe(uploadA.id);
    expect(afterPrepare.extraction_data.source_file_name).toBe(uploadA.file_name);

    const { data: sourceLinks, error: sourceLinksError } = await admin
      .from("document_links")
      .select("file_id, entity_id, link_role")
      .eq("entity_type", "lease")
      .eq("entity_id", leaseId)
      .in("link_role", ["source", "source_file"]);
    await assertNoError(sourceLinksError, "load source links");
    expect(sourceLinks.map((link) => link.file_id)).toContain(uploadA.id);
    expect(sourceLinks.map((link) => link.file_id)).not.toContain(uploadB.id);

    const draftReviews = {
      tenant_name: { status: "accepted", value: `Phase 5D Tenant ${suffix}`, reviewer: actor.email },
      monthly_rent: { status: "edited", value: 12500, note: "Phase 5D sanitized reviewer edit." },
    };
    const saveDraft = await callEdge("save-lease-review-draft", actor.accessToken, {
      lease_id: leaseId,
      field_reviews: draftReviews,
    }, org.id);
    expect(saveDraft.response.status, JSON.stringify(saveDraft.payload)).toBe(200);

    const retryPrepare = await prepareLease(actor.accessToken, org.id, uploadA.id);
    expect(retryPrepare.leaseId).toBe(leaseId);
    expect(retryPrepare.payload.store_result.inserted_count).toBe(0);
    expect(retryPrepare.payload.store_result.existing).toBe(true);

    const afterRetry = await loadLease(admin, leaseId);
    expect(afterRetry.source_file_id).toBe(uploadA.id);
    expect(afterRetry.extraction_data.source_file_id).toBe(uploadA.id);
    expect(afterRetry.extraction_data.field_reviews.monthly_rent.value).toBe(12500);

    const { data: bLeases, error: bLeaseError } = await admin
      .from("leases")
      .select("id")
      .eq("org_id", org.id)
      .eq("source_file_id", uploadB.id);
    await assertNoError(bLeaseError, "upload B lease lookup");
    expect(bLeases).toHaveLength(0);

    const crossPrepare = await callEdge("review-approve", otherActor.accessToken, {
      file_id: uploadA.id,
      action: "prepare",
    }, otherOrg.id);
    expect(crossPrepare.response.status).toBe(404);

    const crossLink = await callEdge("update-lease-extraction-field", actor.accessToken, {
      lease_id: leaseId,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: otherUpload.id, source_file_name: otherUpload.file_name },
    }, org.id);
    expect(crossLink.response.status).toBe(403);

    const approvedReviews = {
      tenant_name: { status: "accepted", value: `Phase 5D Tenant ${suffix}`, reviewer: actor.email },
      property_name: { status: "accepted", value: "Phase 5D Property", reviewer: actor.email },
      commencement_date: { status: "accepted", value: "2026-01-01", reviewer: actor.email },
      expiration_date: { status: "accepted", value: "2030-12-31", reviewer: actor.email },
      monthly_rent: { status: "edited", value: 12500, reviewer: actor.email },
      lease_type: { status: "accepted", value: "nnn", reviewer: actor.email },
    };
    const approveBody = {
      lease_id: leaseId,
      signed_by: actor.email,
      signed_at: "2026-07-17T12:00:00.000Z",
      approval_comments: "Phase 5D source linkage approval.",
      field_reviews: approvedReviews,
      idempotency_key: `phase5d-${suffix}-approve`,
    };
    const approval = await callEdge("approve-lease-workflow", actor.accessToken, approveBody, org.id);
    expect(approval.response.status, JSON.stringify(approval.payload)).toBe(200);

    const afterApproval = await loadLease(admin, leaseId);
    expect(afterApproval.source_file_id).toBe(uploadA.id);
    expect(afterApproval.abstract_snapshot.uploaded_file_id).toBe(uploadA.id);
    expect(afterApproval.abstract_snapshot.source_document.source_file_id).toBe(uploadA.id);

    const approvalRetry = await callEdge("approve-lease-workflow", actor.accessToken, approveBody, org.id);
    expect(approvalRetry.response.status, JSON.stringify(approvalRetry.payload)).toBe(200);
    const afterApprovalRetry = await loadLease(admin, leaseId);
    expect(afterApprovalRetry.source_file_id).toBe(uploadA.id);
    expect(afterApprovalRetry.abstract_snapshot.source_document.uploaded_file_id).toBe(uploadA.id);

    const amendmentUpload = await seedUpload(admin, {
      orgId: org.id,
      actorId: actor.userId,
      fileName: `phase5d-amendment-${suffix}.pdf`,
      tenantName: `Phase 5D Tenant ${suffix}`,
      documentSubtype: "amendment",
    });
    const amendmentPrepare = await prepareLease(actor.accessToken, org.id, amendmentUpload.id);
    expect(amendmentPrepare.leaseId).not.toBe(leaseId);
    const amendmentLease = await loadLease(admin, amendmentPrepare.leaseId);
    expect(amendmentLease.source_file_id).toBe(amendmentUpload.id);
    expect(amendmentLease.source_file_id).not.toBe(uploadA.id);
  }, 120000);
});