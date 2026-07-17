import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { normalizeLeaseReviewData } from "../src/lib/leaseReviewFieldNormalizer.js";
import { resolveBudgetPreviewInputs } from "../src/components/lease-review/utils/budgetPreviewInputs.js";
import { splitRulesForLeaseReview } from "../src/services/utils/leaseExpenseRuleTaxonomy.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Phase 5C integration requires SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in the environment");
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function authedClient(accessToken) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
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

async function createOrgUser(admin, { suffix, orgId, role = "org_admin", pages = {} }) {
  const email = `phase5c-${suffix}@example.test`;
  const password = `Phase5c-${suffix}!Aa1`;
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
    full_name: `Phase 5C ${role}`,
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
    status: "active",
    page_permissions: pages,
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

function extracted(value, page = 1, sourceText = "Sanitized Phase 5C source clause.", confidence = 0.94, extra = {}) {
  return {
    value,
    source_page: page,
    source_text: sourceText,
    confidence,
    extraction_status: "extracted",
    ...extra,
  };
}

function workflowRules(categoryIds, orgId, leaseId, propertyId) {
  return [
    {
      rule_key: `${leaseId}_expense_real_estate_taxes`,
      expense_category_id: categoryIds.real_estate_taxes,
      expense_category: "real_estate_taxes",
      normalized_key: "real_estate_taxes",
      normalized_rule: "Tenant reimburses real estate taxes.",
      responsible_party: "tenant",
      recoverable_from_tenant: "yes",
      cam_eligible: "no",
      payment_treatment: "reimbursable_expense",
      included_in_base_rent: false,
      operational_responsibility: "tenant",
      review_status: "approved",
      approval_status: "approved",
      row_status: "active",
      source_page: 9,
      exact_source_text: "Sanitized tax reimbursement clause.",
      confidence_score: 0.91,
      confidence: 0.91,
      org_id: orgId,
      lease_id: leaseId,
      property_id: propertyId,
      rule_type: "expense_recovery",
      created_from: "phase5c_seed",
      generation_source: "phase5c_local_fixture",
    },
    {
      rule_key: `${leaseId}_expense_utilities_uncertain`,
      expense_category_id: categoryIds.utilities,
      expense_category: "utilities",
      normalized_key: "utilities",
      normalized_rule: "Utility reimbursement needs reviewer confirmation.",
      responsible_party: "tenant",
      recoverable_from_tenant: "conditional",
      cam_eligible: "no",
      payment_treatment: "direct_pay",
      included_in_base_rent: false,
      operational_responsibility: "tenant",
      review_status: "needs_review",
      approval_status: "pending",
      row_status: "needs_review",
      source_page: 10,
      exact_source_text: "Sanitized utilities clause.",
      confidence_score: 0.73,
      confidence: 0.73,
      org_id: orgId,
      lease_id: leaseId,
      property_id: propertyId,
      rule_type: "expense_recovery",
      created_from: "phase5c_seed",
      generation_source: "phase5c_local_fixture",
    },
    {
      rule_key: `${leaseId}_cam_annual_reconciliation`,
      expense_category_id: categoryIds.annual_reconciliation,
      expense_category: "annual_reconciliation",
      normalized_key: "annual_reconciliation",
      normalized_rule: "Annual CAM reconciliation required.",
      responsible_party: "landlord",
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "cam_reconciliation",
      included_in_base_rent: false,
      operational_responsibility: "landlord",
      review_status: "approved",
      approval_status: "approved",
      row_status: "active",
      reconciliation_required: true,
      reconciliation_frequency: "annual",
      source_page: 6,
      exact_source_text: "Sanitized annual CAM reconciliation clause.",
      confidence_score: 0.89,
      confidence: 0.89,
      org_id: orgId,
      lease_id: leaseId,
      property_id: propertyId,
      rule_type: "cam_reconciliation",
      created_from: "phase5c_seed",
      generation_source: "phase5c_local_fixture",
    },
  ];
}

async function seedScenario(admin, suffix) {
  const org = await insertOne(admin, "organizations", {
    name: `Phase 5C Local Org ${suffix}`,
    status: "active",
  });

  const pages = {
    LeaseReview: "admin",
    Leases: "admin",
    LeaseExpenseRules: "admin",
    LeaseExpenseClassification: "admin",
  };
  const actor = await createOrgUser(admin, { suffix: `${suffix}-actor`, orgId: org.id, pages });

  const otherOrg = await insertOne(admin, "organizations", {
    name: `Phase 5C Other Org ${suffix}`,
    status: "active",
  });
  const otherUser = await createOrgUser(admin, { suffix: `${suffix}-other`, orgId: otherOrg.id, pages });

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Phase 5C Property ${suffix}`,
    address: "500 Local Validation Ave",
    status: "active",
  });

  const tenant = await insertOne(admin, "tenants", {
    org_id: org.id,
    name: `Phase 5C Tenant ${suffix}`,
    email: `tenant-phase5c-${suffix}@example.test`,
    status: "active",
  });

  const categories = {};
  for (const category of [
    ["real_estate_taxes", "Real Estate Taxes"],
    ["utilities", "Utilities"],
    ["annual_reconciliation", "Annual Reconciliation"],
  ]) {
    const row = await insertOne(admin, "expense_categories", {
      org_id: org.id,
      normalized_key: category[0],
      category_name: category[1],
      is_active: true,
      is_system_default: false,
    });
    categories[category[0]] = row.id;
  }

  const fieldReviews = {
    monthly_rent: { status: "edited", value: 12000, note: "Existing reviewer edit before Phase 5C." },
    commencement_date: { status: "pending" },
    lease_type: { status: "not_applicable", note: "Optional for this local validation." },
    security_deposit: { status: "needs_review", note: "Conflicting sanitized values remain unresolved." },
  };

  const fields = {
    tenant_name: extracted(tenant.name, 1, "Sanitized tenant clause."),
    landlord_name: extracted("Phase 5C Owner LLC", 1, "Sanitized landlord clause."),
    property_address: extracted("500 Local Validation Ave, Suite 120", 2, "Sanitized premises clause."),
    commencement_date: extracted("2026-01-01", 3, "Sanitized commencement clause."),
    expiration_date: extracted("2031-12-31", 3, "Sanitized expiration clause."),
    monthly_rent: extracted(11000, 4, "Sanitized base rent clause."),
    annual_rent: extracted(132000, 4, "Sanitized annual rent clause."),
    escalation_rate: extracted(3, 5, "Sanitized escalation clause."),
    lease_type: extracted("nnn", 5, "Sanitized lease type clause."),
    security_deposit: extracted(30000, 7, "Sanitized conflicting security deposit clause.", 0.72, {
      extraction_status: "conflict_detected",
      evidence_type: "conflict",
    }),
  };

  const uploaded = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `phase5c-${suffix}.pdf`,
    file_url: `local://phase5c/${suffix}.pdf`,
    file_size: 2048,
    mime_type: "application/pdf",
    uploaded_by: actor.userId,
    status: "completed",
    processing_status: "completed",
    extraction_method: "phase5c_seeded_local_fixture",
    document_subtype: "base_lease",
    review_required: true,
    review_status: "review_ready",
    normalized_output: {
      records: [{ fields }],
      metadata: { phase: "5C", sanitized: true },
    },
    ui_review_payload: {
      records: [{ fields }],
      metadata: { phase: "5C", sanitized: true },
    },
    parsed_data: { raw_text: "Sanitized Phase 5C local lease text." },
    docling_raw: { full_text: "Sanitized Phase 5C local docling text." },
    review_audit: {},
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    start_date: "2026-01-15",
    commencement_date: "2026-01-15",
    expiration_date: "2031-12-31",
    end_date: "2031-12-31",
    monthly_rent: 99999,
    annual_rent: 1199988,
    escalation_rate: 9,
    status: "pending",
    abstract_status: "draft",
    abstract_version: 0,
    source_file_id: uploaded.id,
    extraction_data: {
      source_file_id: uploaded.id,
      fields,
      field_evidence: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
        source_text: value.source_text,
        source_page: value.source_page,
      }])),
      field_reviews: fieldReviews,
      workflow_output: {
        document_profile: { documentType: "base_lease" },
        selected_document_profile: "base_lease",
        expense_rules: [],
        budget_preview: {
          rent_revenue_budget: [{ monthly_rent: 10000, start_date: "2026-02-01" }],
        },
        v3_diagnostics: {
          approval_advisory: { current_status: "advisory_only_no_gate" },
        },
      },
    },
  });

  const rules = workflowRules(categories, org.id, lease.id, property.id);
  const { data: seededLease, error: updateError } = await admin
    .from("leases")
    .update({
      extraction_data: {
        ...lease.extraction_data,
        workflow_output: {
          ...lease.extraction_data.workflow_output,
          expense_rules: rules,
        },
      },
    })
    .eq("id", lease.id)
    .select("*")
    .single();
  await assertNoError(updateError, "attach workflow rules");

  await insertOne(admin, "document_links", {
    org_id: org.id,
    file_id: uploaded.id,
    entity_type: "lease",
    entity_id: lease.id,
    link_role: "source_file",
    created_by: actor.userId,
  });

  return { org, otherOrg, actor, otherUser, property, tenant, uploaded, lease: seededLease, rules };
}

function deriveBlockers(lease, fieldReviews) {
  const normalized = normalizeLeaseReviewData(lease, { fieldReviews });
  const unresolved = Object.entries(fieldReviews).filter(([, review]) => ["pending", "needs_review", "needs_legal"].includes(review?.status));
  return {
    normalized,
    blockerKeys: unresolved.map(([key]) => key),
    canApprove: unresolved.length === 0,
  };
}

function rulePayload(rule, override = {}) {
  return {
    ...rule,
    ...override,
    mentioned_in_lease: true,
    extraction_status: rule.extraction_status || "extracted",
  };
}

describe("Phase 5C authenticated local review-to-financial integration", () => {
  it("validates reviewer save, rules, approval, idempotency, isolation, and downstream durable state", async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const scenario = await seedScenario(admin, suffix);
    const { org, actor, otherUser, lease, rules } = scenario;
    const userClient = authedClient(actor.accessToken);
    const otherClient = authedClient(otherUser.accessToken);

    const { data: loadedLease, error: loadError } = await userClient
      .from("leases")
      .select("*")
      .eq("id", lease.id)
      .single();
    await assertNoError(loadError, "authenticated lease load");
    expect(loadedLease.id).toBe(lease.id);
    expect(loadedLease.extraction_data.workflow_output.expense_rules).toHaveLength(3);

    const nextFieldReviewsBlocked = {
      monthly_rent: {
        status: "edited",
        value: 13500,
        note: "Phase 5C reviewer confirmed sanitized rent schedule.",
        source_page: 4,
        source_text: "Sanitized base rent clause.",
        confidence: 0.94,
        reviewed_at: "2026-07-17T06:00:00.000Z",
        reviewer: actor.email,
      },
      commencement_date: {
        status: "accepted",
        value: "2026-03-01",
        note: "Phase 5C reviewer accepted commencement.",
        source_page: 3,
        source_text: "Sanitized commencement clause.",
        confidence: 0.94,
        reviewed_at: "2026-07-17T06:01:00.000Z",
        reviewer: actor.email,
      },
      lease_type: {
        status: "not_applicable",
        note: "Optional field marked N/A for Phase 5C.",
        reviewed_at: "2026-07-17T06:02:00.000Z",
        reviewer: actor.email,
      },
      escalation_rate: {
        status: "accepted",
        value: 3,
        source_page: 5,
        source_text: "Sanitized escalation clause.",
        confidence: 0.93,
        reviewed_at: "2026-07-17T06:03:00.000Z",
        reviewer: actor.email,
      },
      security_deposit: {
        status: "needs_review",
        note: "Required conflict intentionally unresolved for blocked approval check.",
        source_page: 7,
        source_text: "Sanitized conflicting security deposit clause.",
        confidence: 0.72,
      },
    };

    const blockedReadiness = deriveBlockers(loadedLease, nextFieldReviewsBlocked);
    expect(blockedReadiness.canApprove).toBe(false);
    expect(blockedReadiness.blockerKeys).toContain("security_deposit");
    expect(blockedReadiness.blockerKeys).not.toContain("lease_type");
    expect(blockedReadiness.normalized.approvalBlockers.warnings.join(" ")).not.toMatch(/v3/i);

    const draft1 = await callEdge("save-lease-review-draft", actor.accessToken, {
      lease_id: lease.id,
      field_reviews: nextFieldReviewsBlocked,
    }, org.id);
    expect(draft1.response.status, JSON.stringify(draft1.payload)).toBe(200);
    expect(draft1.payload.abstract_status).toBe("pending_review");

    const draftRetry = await callEdge("save-lease-review-draft", actor.accessToken, {
      lease_id: lease.id,
      field_reviews: nextFieldReviewsBlocked,
    }, org.id);
    expect(draftRetry.response.status, JSON.stringify(draftRetry.payload)).toBe(200);

    const { data: afterDraft, error: draftReloadError } = await admin
      .from("leases")
      .select("*")
      .eq("id", lease.id)
      .single();
    await assertNoError(draftReloadError, "reload after draft");
    expect(afterDraft.extraction_data.field_reviews.monthly_rent.value).toBe(13500);
    expect(afterDraft.extraction_data.field_reviews.commencement_date.status).toBe("accepted");
    expect(afterDraft.extraction_data.field_reviews.lease_type.status).toBe("not_applicable");
    expect(afterDraft.extraction_data.field_reviews.monthly_rent.note).toMatch(/reviewer confirmed/);
    expect(afterDraft.extraction_data.field_evidence.monthly_rent.source_text).toBe("Sanitized base rent clause.");

    const budgetInputs = resolveBudgetPreviewInputs(afterDraft);
    expect(budgetInputs).toEqual({ monthly: 13500, startBasis: "2026-03-01", escalationRate: 3 });

    const { expenseRules, camRules } = splitRulesForLeaseReview(rules);
    expect(expenseRules.map((rule) => rule.expense_category)).toEqual(expect.arrayContaining(["real_estate_taxes", "utilities"]));
    expect(camRules.map((rule) => rule.expense_category)).toContain("annual_reconciliation");

    const saveRules = await callEdge("save-lease-expense-rule-set", actor.accessToken, {
      lease_id: lease.id,
      rule_set_id: null,
      version: 1,
      status: "draft",
      extraction_version: "phase5c_local_seed",
      property_id: scenario.property.id,
      rules: [
        rulePayload(rules[0], { review_status: "approved", approval_status: "approved" }),
        rulePayload(rules[1], { review_status: "needs_review", approval_status: "pending" }),
        rulePayload(rules[2], { review_status: "approved", approval_status: "approved", published_to_cam: true }),
      ],
      values: [],
      clauses: rules.map((rule) => ({
        rule_key: rule.rule_key,
        lease_id: lease.id,
        page_number: rule.source_page,
        clause_type: rule.expense_category,
        clause_text: rule.exact_source_text,
        confidence: rule.confidence_score,
      })),
      superseded_rule_ids: [],
    }, org.id);
    expect(saveRules.response.status, JSON.stringify(saveRules.payload)).toBe(200);
    const ruleSetId = saveRules.payload.rule_set_id;
    expect(ruleSetId).toBeTruthy();

    const blockedApprovalVersions = await admin
      .from("lease_abstract_versions")
      .select("id")
      .eq("lease_id", lease.id);
    await assertNoError(blockedApprovalVersions.error, "version check before approval");
    expect(blockedApprovalVersions.data).toHaveLength(0);

    const resolvedFieldReviews = {
      ...nextFieldReviewsBlocked,
      security_deposit: {
        status: "edited",
        value: 32500,
        note: "Phase 5C reviewer resolved sanitized conflict.",
        source_page: 7,
        source_text: "Sanitized conflicting security deposit clause.",
        confidence: 0.72,
        reviewed_at: "2026-07-17T06:05:00.000Z",
        reviewer: actor.email,
      },
    };
    const clearReadiness = deriveBlockers(afterDraft, resolvedFieldReviews);
    expect(clearReadiness.canApprove).toBe(true);

    const draftResolved = await callEdge("save-lease-review-draft", actor.accessToken, {
      lease_id: lease.id,
      field_reviews: resolvedFieldReviews,
    }, org.id);
    expect(draftResolved.response.status, JSON.stringify(draftResolved.payload)).toBe(200);

    const idempotencyKey = `phase5c-approval-${suffix}`;
    const approvalBody = {
      lease_id: lease.id,
      signed_by: "Phase 5C Local Reviewer",
      signed_at: "2026-07-17T06:10:00.000Z",
      approval_comments: "Phase 5C local approved abstract.",
      approval_document_url: "https://example.test/phase5c-local-approval.pdf",
      field_reviews: resolvedFieldReviews,
      idempotency_key: idempotencyKey,
    };

    const approval = await callEdge("approve-lease-workflow", actor.accessToken, approvalBody, org.id);
    expect(approval.response.status, JSON.stringify(approval.payload)).toBe(200);
    expect(approval.payload.error).toBe(false);
    expect(approval.payload.already_approved).toBe(false);
    expect(approval.payload.abstract_version_id).toBeTruthy();

    const approvalRetry = await callEdge("approve-lease-workflow", actor.accessToken, approvalBody, org.id);
    expect(approvalRetry.response.status, JSON.stringify(approvalRetry.payload)).toBe(200);
    expect(approvalRetry.payload.abstract_version_id).toBe(approval.payload.abstract_version_id);

    const { data: approvedLease, error: approvedLeaseError } = await admin
      .from("leases")
      .select("*")
      .eq("id", lease.id)
      .single();
    await assertNoError(approvedLeaseError, "reload approved lease");
    expect(approvedLease.status).toBe("approved");
    expect(approvedLease.abstract_status).toBe("approved");
    expect(approvedLease.abstract_version).toBe(1);
    expect(approvedLease.extraction_data.field_reviews.monthly_rent.value).toBe(13500);
    expect(approvedLease.abstract_snapshot.fields.monthly_rent.value).toBe(13500);
    expect(approvedLease.abstract_snapshot.fields.security_deposit.value).toBe(32500);
    expect(approvedLease.abstract_approved_by).toBe("Phase 5C Local Reviewer");
    expect(approvedLease.abstract_approved_at).toBeTruthy();

    const { data: versionRows, error: versionError } = await admin
      .from("lease_abstract_versions")
      .select("*")
      .eq("lease_id", lease.id);
    await assertNoError(versionError, "version rows");
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0].field_reviews.monthly_rent.value).toBe(13500);
    expect(versionRows[0].abstract_snapshot.fields.commencement_date.value).toBe("2026-03-01");

    const { data: reviewRows, error: reviewRowsError } = await admin
      .from("lease_field_reviews")
      .select("field_key,status,normalized_value,note,source_text,reviewer")
      .eq("lease_id", lease.id);
    await assertNoError(reviewRowsError, "lease_field_reviews");
    expect(reviewRows.find((row) => row.field_key === "monthly_rent")?.normalized_value).toBe("13500");
    expect(reviewRows.find((row) => row.field_key === "security_deposit")?.status).toBe("edited");

    const { data: persistedRuleSets, error: ruleSetError } = await admin
      .from("lease_expense_rule_sets")
      .select("*")
      .eq("lease_id", lease.id);
    await assertNoError(ruleSetError, "persisted rule sets");
    expect(persistedRuleSets).toHaveLength(1);

    const { data: persistedRules, error: persistedRulesError } = await admin
      .from("lease_expense_rules")
      .select("*, lease_expense_rule_clauses(*)")
      .eq("lease_id", lease.id);
    await assertNoError(persistedRulesError, "persisted rules");
    expect(persistedRules).toHaveLength(3);
    expect(persistedRules.filter((rule) => rule.expense_category === "real_estate_taxes")).toHaveLength(1);
    expect(persistedRules.find((rule) => rule.expense_category === "real_estate_taxes")?.review_status).toBe("approved");
    expect(persistedRules.find((rule) => rule.expense_category === "utilities")?.review_status).toBe("needs_review");
    const persistedCam = persistedRules.find((rule) => rule.expense_category === "annual_reconciliation");
    expect(persistedCam?.cam_eligible).toBe("yes");
    expect(persistedCam?.published_to_cam).toBe(true);
    expect(persistedCam?.review_status).toBe("approved");
    expect(persistedCam?.exact_source_text).toBe("Sanitized annual CAM reconciliation clause.");
    expect(persistedRules.filter((rule) => rule.rule_key === rules[2].rule_key)).toHaveLength(1);

    const { data: criticalDates, error: criticalDateError } = await admin
      .from("lease_critical_dates")
      .select("*")
      .eq("lease_id", lease.id);
    await assertNoError(criticalDateError, "critical dates");
    const criticalDateCount = criticalDates.length;

    const { data: criticalDatesAfterRetry, error: criticalDateRetryError } = await admin
      .from("lease_critical_dates")
      .select("*")
      .eq("lease_id", lease.id);
    await assertNoError(criticalDateRetryError, "critical dates after retry");
    expect(criticalDatesAfterRetry).toHaveLength(criticalDateCount);

    const { data: workflowRuns, error: workflowRunError } = await admin
      .from("lease_approval_workflow_runs")
      .select("*")
      .eq("lease_id", lease.id)
      .eq("idempotency_key", idempotencyKey);
    await assertNoError(workflowRunError, "workflow runs");
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].status).toBe("completed");
    expect(workflowRuns[0].actor_email).toBe(actor.email);

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("action,actor_email,entity_id,metadata")
      .eq("entity_id", lease.id);
    await assertNoError(auditError, "audit logs");
    expect(auditRows.some((row) => row.action === "lease_review_draft_saved")).toBe(true);
    expect(auditRows.some((row) => row.action === "lease_abstract_approved")).toBe(true);

    const { data: otherLeaseRead, error: otherLeaseReadError } = await otherClient
      .from("leases")
      .select("id")
      .eq("id", lease.id);
    await assertNoError(otherLeaseReadError, "other org lease read");
    expect(otherLeaseRead).toHaveLength(0);

    const otherDraft = await callEdge("save-lease-review-draft", otherUser.accessToken, {
      lease_id: lease.id,
      field_reviews: resolvedFieldReviews,
    }, scenario.otherOrg.id);
    expect([400, 403, 404, 500]).toContain(otherDraft.response.status);
    expect(JSON.stringify(otherDraft.payload)).toMatch(/not found|access denied|failed/i);

    const otherApproval = await callEdge("approve-lease-workflow", otherUser.accessToken, approvalBody, scenario.otherOrg.id);
    expect([403, 404]).toContain(otherApproval.response.status);

    const { data: otherRuleRead, error: otherRuleReadError } = await otherClient
      .from("lease_expense_rules")
      .select("id")
      .eq("lease_id", lease.id);
    await assertNoError(otherRuleReadError, "other org rule read");
    expect(otherRuleRead).toHaveLength(0);

    const { data: finalRules, error: finalRulesError } = await admin
      .from("lease_expense_rules")
      .select("id,rule_key,expense_category")
      .eq("lease_id", lease.id);
    await assertNoError(finalRulesError, "final rules");
    expect(finalRules).toHaveLength(3);
  }, 120000);
});