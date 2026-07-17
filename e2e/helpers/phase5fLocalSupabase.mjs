import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export function parseSupabaseEnv(output) {
  const env = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function getLocalSupabaseEnv() {
  const output = execFileSync("supabase", ["status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const env = parseSupabaseEnv(output);
  if (!env.API_URL || !env.ANON_KEY || !env.SERVICE_ROLE_KEY) {
    throw new Error("Local Supabase env is incomplete. Start Supabase before running Phase 5F E2E.");
  }
  return env;
}

export function createLocalAdminClient() {
  const env = getLocalSupabaseEnv();
  return {
    env,
    admin: createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

async function stripMissingColumns(writeFn, row) {
  const payload = { ...row };
  const stripped = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data, error } = await writeFn(payload);
    if (!error) return { data, stripped };
    const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
    const missing = text.match(/Could not find the '([^']+)' column/i)?.[1]
      || text.match(/column\s+"?([a-zA-Z0-9_]+)"?/i)?.[1];
    if (!missing || !(missing in payload)) throw error;
    delete payload[missing];
    stripped.push(missing);
  }
  throw new Error(`Too many missing-column retries: ${stripped.join(", ")}`);
}

async function insertRow(admin, table, row) {
  const result = await stripMissingColumns(
    (payload) => admin.from(table).insert(payload).select("*").single(),
    row,
  );
  return result.data;
}

async function upsertRow(admin, table, row, onConflict) {
  const result = await stripMissingColumns(
    (payload) => admin.from(table).upsert(payload, onConflict ? { onConflict } : undefined).select("*").single(),
    row,
  );
  return result.data;
}

async function ensureAuthUser(admin, { email, password, fullName }) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { provider: "google", providers: ["google"] },
  });
  if (!error && created?.user?.id) return created.user;

  if (!/already registered|already exists|User already/i.test(error?.message || "")) {
    throw error;
  }

  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw listError;
  const existing = listed?.users?.find((user) => user.email?.toLowerCase() === email.toLowerCase());
  if (!existing) throw error;
  await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true, user_metadata: { full_name: fullName }, app_metadata: { provider: "google", providers: ["google"] } });
  return existing;
}

function field(value, sourcePage, sourceText, confidence = 0.96, extractionStatus = "extracted") {
  return {
    value,
    normalized_value: value,
    raw_value: value,
    source_page: sourcePage,
    page_number: sourcePage,
    source_text: sourceText,
    exact_source_text: sourceText,
    confidence,
    confidence_score: confidence,
    extraction_status: extractionStatus,
    status: extractionStatus,
    evidence_type: extractionStatus === "conflict_detected" ? "conflict" : "source",
  };
}

function standardFields(fields) {
  return Object.entries(fields).map(([field_key, value]) => ({
    field_key,
    key: field_key,
    label: field_key.replace(/_/g, " "),
    value: value.value,
    normalized_value: value.value,
    raw_value: value.raw_value,
    source_page: value.source_page,
    page_number: value.source_page,
    source_text: value.source_text,
    exact_source_text: value.source_text,
    confidence: value.confidence,
    confidence_score: value.confidence_score,
    extraction_status: value.extraction_status,
    status: value.status,
    evidence_type: value.evidence_type,
  }));
}

export async function seedPhase5fScenario() {
  const { env, admin } = createLocalAdminClient();
  const suffix = randomUUID().slice(0, 8);
  const password = `Phase5f!${suffix}A1`;
  const orgAId = randomUUID();
  const orgBId = randomUUID();
  const propertyId = randomUUID();
  const uploadId = randomUUID();
  const leaseId = randomUUID();
  const reviewerEmail = `phase5f-reviewer-${suffix}@example.test`;
  const otherEmail = `phase5f-other-${suffix}@example.test`;

  const reviewer = await ensureAuthUser(admin, { email: reviewerEmail, password, fullName: "Phase 5F Reviewer" });
  const otherUser = await ensureAuthUser(admin, { email: otherEmail, password, fullName: "Phase 5F Other Org" });

  await insertRow(admin, "organizations", { id: orgAId, name: `Phase 5F Org ${suffix}`, status: "active", primary_contact_email: reviewerEmail });
  await insertRow(admin, "organizations", { id: orgBId, name: `Phase 5F Other Org ${suffix}`, status: "active", primary_contact_email: otherEmail });
  await insertRow(admin, "properties", {
    id: propertyId,
    org_id: orgAId,
    name: `Phase 5F Plaza ${suffix}`,
    address: "1200 Market Street",
    city: "Denver",
    state: "CO",
    zip: "80202",
    property_type: "retail",
    status: "active",
  });
  await upsertRow(admin, "profiles", {
    id: reviewer.id,
    email: reviewerEmail,
    full_name: "Phase 5F Reviewer",
    role: "editor",
    status: "active",
    onboarding_type: "invited",
    onboarding_complete: true,
    first_login: false,
    dashboard_viewed: true,
  }, "id");
  await upsertRow(admin, "profiles", {
    id: otherUser.id,
    email: otherEmail,
    full_name: "Phase 5F Other Org",
    role: "editor",
    status: "active",
    onboarding_type: "invited",
    onboarding_complete: true,
    first_login: false,
    dashboard_viewed: true,
  }, "id");
  await upsertRow(admin, "memberships", { user_id: reviewer.id, org_id: orgAId, role: "editor", status: "active" }, "user_id,org_id");
  await upsertRow(admin, "memberships", { user_id: otherUser.id, org_id: orgBId, role: "editor", status: "active" }, "user_id,org_id");
  await upsertRow(admin, "user_access", {
    user_id: reviewer.id,
    org_id: orgAId,
    scope: "property",
    scope_id: propertyId,
    role: "editor",
    is_active: true,
    granted_by: reviewer.id,
  }, "user_id,scope,scope_id");

  const fields = {
    tenant_name: field("Bluebird Bakery LLC", 1, "Tenant: Bluebird Bakery LLC"),
    landlord_name: field("Redwood Plaza Owner LP", 1, "Landlord: Redwood Plaza Owner LP"),
    premises_address: field("1200 Market Street, Suite 210, Denver, CO", 2, "Premises: 1200 Market Street, Suite 210"),
    square_footage: field(4200, 2, "Premises consists of 4,200 rentable square feet"),
    premises_use: field("Retail bakery and cafe", 2, "Tenant may use the Premises for a retail bakery and cafe"),
    lease_date: field("2026-01-15", 1, "Lease dated January 15, 2026"),
    lease_type: field("triple_net", 3, "This Lease is triple net"),
    lease_term: field("60 months", 4, "The initial term is sixty (60) months"),
    commencement_date: field("2026-02-01", 4, "The commencement date is February 1, 2026"),
    expiration_date: field("2031-01-31", 4, "The expiration date is January 31, 2031"),
    monthly_rent: field(20000, 5, "Base Rent is $20,000 per month"),
    security_deposit: field(30000, 6, "Security deposit listed as $30,000 in one paragraph", 0.53, "conflict_detected"),
    parking_rights: field("not_applicable", 8, "No reserved parking rights are granted", 0.9),
    tenant_pro_rata_share: field(12.5, 9, "Tenant's pro rata share is 12.5%"),
    admin_fee_percent: field(5, 9, "Administrative fee equals 5% of CAM costs"),
    renewal_notice_days: field(180, 12, "Tenant must deliver renewal notice at least 180 days before expiration"),
  };

  const fieldEvidence = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
    raw_value: value.raw_value,
    source_page: value.source_page,
    source_text: value.source_text,
    exact_source_text: value.exact_source_text,
    confidence: value.confidence,
    confidence_score: value.confidence_score,
    extraction_status: value.extraction_status,
  }]));
  const confidenceScores = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.confidence]));
  const workflowOutput = {
    lease_fields: fields,
    expense_rules: [
      {
        expense_category: "operating_expenses",
        rule_type: "expense_recovery",
        payment_treatment: "pass_through",
        recoverable_from_tenant: "yes",
        cam_eligible: "yes",
        tenant_share_percent: 12.5,
        admin_fee_percent: 5,
        source_page: 9,
        exact_source_text: "Tenant shall pay its pro rata share of operating expenses plus a 5% administrative fee.",
        confidence_score: 0.94,
        extraction_status: "extracted",
      },
      {
        expense_category: "utilities",
        rule_type: "direct_tenant_responsibility",
        payment_treatment: "direct_pay",
        recoverable_from_tenant: "yes",
        cam_eligible: "no",
        source_page: 10,
        exact_source_text: "Tenant is responsible for separately metered utilities.",
        confidence_score: 0.92,
        extraction_status: "extracted",
      },
    ],
    budget_preview: { monthly_rent: 20000, source: "workflow_fixture" },
    budget_handoff_readiness: { ready: false, blocked_reasons: ["Lease abstract not approved"], excluded_unapproved_inputs: ["monthly_rent"] },
  };
  const fieldReviews = {
    tenant_name: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    landlord_name: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    premises_address: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    square_footage: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    premises_use: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    lease_date: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    lease_type: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    lease_term: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    commencement_date: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    expiration_date: { status: "accepted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    monthly_rent: { status: "edited", value: 23500, raw_value: "$23,500 per month", source_page: 5, source_text: "Reviewer corrected Base Rent to $23,500 per month from the signed schedule.", confidence: 1, extraction_status: "extracted", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
    security_deposit: { status: "needs_review", value: 30000, source_page: 6, source_text: "Conflicting deposit references require reviewer decision.", confidence: 0.53, extraction_status: "conflict_detected" },
    parking_rights: { status: "not_applicable", reviewed_at: new Date().toISOString(), reviewer: reviewerEmail },
  };
  const extractionData = {
    source_file_id: uploadId,
    uploaded_file_id: uploadId,
    source_file_name: `phase5f-seeded-${suffix}.pdf`,
    document_subtype: "base_lease",
    fields,
    field_evidence: fieldEvidence,
    confidence_scores: confidenceScores,
    workflow_output: workflowOutput,
    field_reviews: fieldReviews,
    conflicts: {
      security_deposit: {
        reason: "Conflicting security deposit amounts in seeded evidence",
        candidates: [30000, 32500],
      },
    },
    phase5f_fixture: true,
  };
  const uiReviewPayload = {
    lease_id: leaseId,
    records: [{ lease_id: leaseId, fields, standard_fields: standardFields(fields), workflow_output: workflowOutput }],
    metadata: { phase: "5F", source_file_id: uploadId, workflow_output: workflowOutput },
  };

  await insertRow(admin, "uploaded_files", {
    id: uploadId,
    org_id: orgAId,
    module_type: "leases",
    file_name: `phase5f-seeded-${suffix}.pdf`,
    file_url: `${env.API_URL}/storage/v1/object/public/financial-uploads/phase5f/${uploadId}.pdf`,
    file_size: 12048,
    mime_type: "application/pdf",
    uploaded_by: reviewerEmail,
    status: "review_required",
    processing_status: "review_required",
    review_required: true,
    review_status: "pending",
    ui_review_payload: uiReviewPayload,
    normalized_output: { rows: [fields], metadata: { phase: "5F" } },
    parsed_data: [{ synthetic_fixture: true }],
    valid_data: [{ synthetic_fixture: true }],
    row_count: 1,
    valid_count: 1,
    confirmed_at: new Date().toISOString(),
    processing_completed_at: new Date().toISOString(),
  });

  await insertRow(admin, "leases", {
    id: leaseId,
    org_id: orgAId,
    property_id: propertyId,
    tenant_name: "Bluebird Bakery LLC",
    landlord_name: "Redwood Plaza Owner LP",
    start_date: "2026-02-01",
    end_date: "2031-01-31",
    commencement_date: "2026-02-01",
    expiration_date: "2031-01-31",
    monthly_rent: null,
    square_footage: 4200,
    security_deposit: 30000,
    lease_type: "triple_net",
    status: "pending_review",
    abstract_status: "pending_review",
    abstract_version: 0,
    source_file_id: uploadId,
    extraction_data: extractionData,
    extracted_fields: fields,
    created_by: reviewerEmail,
  });
  await insertRow(admin, "document_links", { org_id: orgAId, file_id: uploadId, entity_type: "lease", entity_id: leaseId, link_role: "source", created_by: reviewer.id });

  return {
    env: { API_URL: env.API_URL },
    orgAId,
    orgBId,
    propertyId,
    uploadId,
    leaseId,
    reviewer: { id: reviewer.id, email: reviewerEmail, password },
    otherUser: { id: otherUser.id, email: otherEmail, password },
    fileName: `phase5f-seeded-${suffix}.pdf`,
  };
}

export async function inspectPhase5fState(ids) {
  const { admin } = createLocalAdminClient();
  const [leaseResult, uploadResult, versionsResult, linksResult, rulesResult, datesResult, runsResult] = await Promise.all([
    admin.from("leases").select("*").eq("id", ids.leaseId).single(),
    admin.from("uploaded_files").select("*").eq("id", ids.uploadId).single(),
    admin.from("lease_abstract_versions").select("*").eq("lease_id", ids.leaseId).order("version", { ascending: true }),
    admin.from("document_links").select("*").eq("entity_type", "lease").eq("entity_id", ids.leaseId),
    admin.from("lease_expense_rules").select("*").eq("lease_id", ids.leaseId),
    admin.from("lease_critical_dates").select("*").eq("lease_id", ids.leaseId),
    admin.from("lease_approval_workflow_runs").select("*").eq("lease_id", ids.leaseId).order("created_at", { ascending: true }),
  ]);
  for (const result of [leaseResult, uploadResult, versionsResult, linksResult, rulesResult, datesResult, runsResult]) {
    if (result.error && !/Could not find|does not exist|schema cache/i.test(result.error.message || "")) throw result.error;
  }
  return {
    lease: leaseResult.data,
    upload: uploadResult.data,
    versions: versionsResult.data || [],
    links: linksResult.data || [],
    rules: rulesResult.data || [],
    criticalDates: datesResult.data || [],
    runs: runsResult.data || [],
  };
}