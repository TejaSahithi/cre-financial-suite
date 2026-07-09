// Feature: enterprise-readiness-hardening Phase 4B (budget write-path closure)
// Properties:
//   1. compute-budget's new mark_reviewed action transitions
//      draft/ai_generated/under_review -> reviewed, and rejects an
//      ineligible status (e.g. 'reviewed' itself, already there).
//   2. compute-budget's reject action requires a non-empty reason, is
//      blocked once a budget is approved/locked/signed, and otherwise
//      transitions back to 'draft' with rejection_comment/rejected_at/
//      rejected_by set.
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

async function setUpOrgAndUser(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `budget-phase4b-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: actorEmail,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const actorUserId = userData.user?.id;
  assertExists(actorUserId);

  const org = await insertOne(admin, "organizations", {
    name: `Budget Phase4b Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Budget Phase4b Tester",
    role: "org_admin",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: actorUserId,
    org_id: org.id,
    role: "org_admin",
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email: actorEmail,
    password,
  });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { org, actorUserId, accessToken };
}

async function setUpPropertyWithBudget(admin: ReturnType<typeof adminClient>, orgId: string, suffix: string, fiscalYear: number, accessToken: string) {
  const property = await insertOne(admin, "properties", {
    org_id: orgId,
    name: `Budget Phase4b Property ${suffix}`,
    status: "active",
  });

  await insertOne(admin, "computation_snapshots", {
    org_id: orgId,
    property_id: property.id,
    engine_type: "revenue",
    fiscal_year: fiscalYear,
    inputs: {},
    outputs: { summary: { revenue_by_type: { base_rent: 8000, other_income: 0 } } },
  });
  await insertOne(admin, "computation_snapshots", {
    org_id: orgId,
    property_id: property.id,
    engine_type: "expense",
    fiscal_year: fiscalYear,
    inputs: {},
    outputs: { total_expenses: 3000 },
  });

  const generateRes = await fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({
      action: "generate",
      property_id: property.id,
      fiscal_year: fiscalYear,
      allow_generate_without_cam: true,
    }),
  });
  const generateBody = await generateRes.json();
  assertEquals(generateRes.status, 200, `expected generate to succeed: ${JSON.stringify(generateBody)}`);

  return { property, budgetId: generateBody.budget_id };
}

function callComputeBudget(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
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
  name: "HTTP compute-budget mark_reviewed: transitions draft -> reviewed, blocked once already reviewed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);
    const fiscalYear = 2026;
    const { property, budgetId } = await setUpPropertyWithBudget(admin, org.id, suffix, fiscalYear, accessToken);

    const reviewRes = await callComputeBudget(accessToken, {
      action: "mark_reviewed",
      property_id: property.id,
      fiscal_year: fiscalYear,
    });
    const reviewBody = await reviewRes.json();
    assertEquals(reviewRes.status, 200, `expected mark_reviewed to succeed: ${JSON.stringify(reviewBody)}`);
    assertEquals(reviewBody.status, "reviewed");

    const { data: row, error } = await admin.from("budgets").select("status, reviewed_at, reviewed_by").eq("id", budgetId).single();
    assertNoError(error);
    assertExists(row);
    assertEquals(row.status, "reviewed");
    assertExists(row.reviewed_at);
    assertExists(row.reviewed_by);

    // Already reviewed — must not be markable as reviewed again from this state
    // under the allowed-from set (draft/ai_generated/under_review).
    const secondReviewRes = await callComputeBudget(accessToken, {
      action: "mark_reviewed",
      property_id: property.id,
      fiscal_year: fiscalYear,
    });
    const secondReviewBody = await secondReviewRes.json();
    assertEquals(secondReviewBody.error, true, "mark_reviewed must be blocked once already reviewed");
  },
});

Deno.test({
  name: "HTTP compute-budget reject: requires a reason, transitions back to draft, and is blocked once locked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);
    const fiscalYear = 2026;
    const { property, budgetId } = await setUpPropertyWithBudget(admin, org.id, suffix, fiscalYear, accessToken);

    // Reject without a reason must be rejected.
    const noReasonRes = await callComputeBudget(accessToken, {
      action: "reject",
      property_id: property.id,
      fiscal_year: fiscalYear,
    });
    const noReasonBody = await noReasonRes.json();
    assertEquals(noReasonBody.error, true, "reject without a reason must be blocked");

    // Reject with a reason from 'draft' succeeds and sets the rejection fields.
    const reason = "Expense projections look too low based on renewal quotes.";
    const rejectRes = await callComputeBudget(accessToken, {
      action: "reject",
      property_id: property.id,
      fiscal_year: fiscalYear,
      reason,
    });
    const rejectBody = await rejectRes.json();
    assertEquals(rejectRes.status, 200, `expected reject to succeed: ${JSON.stringify(rejectBody)}`);
    assertEquals(rejectBody.status, "draft");
    assertEquals(rejectBody.rejection_comment, reason);

    const { data: row, error } = await admin
      .from("budgets")
      .select("status, rejection_comment, rejected_at, rejected_by")
      .eq("id", budgetId)
      .single();
    assertNoError(error);
    assertExists(row);
    assertEquals(row.status, "draft");
    assertEquals(row.rejection_comment, reason);
    assertExists(row.rejected_at);
    assertExists(row.rejected_by);

    // Drive the budget to locked, then confirm reject is blocked.
    await callComputeBudget(accessToken, { action: "mark_reviewed", property_id: property.id, fiscal_year: fiscalYear });
    await callComputeBudget(accessToken, { action: "approve", property_id: property.id, fiscal_year: fiscalYear });
    const lockRes = await callComputeBudget(accessToken, { action: "lock", property_id: property.id, fiscal_year: fiscalYear });
    const lockBody = await lockRes.json();
    assertEquals(lockRes.status, 200, `expected lock to succeed: ${JSON.stringify(lockBody)}`);

    const rejectLockedRes = await callComputeBudget(accessToken, {
      action: "reject",
      property_id: property.id,
      fiscal_year: fiscalYear,
      reason: "Trying to reject a locked budget",
    });
    const rejectLockedBody = await rejectLockedRes.json();
    assertEquals(rejectLockedBody.error, true, "reject must be blocked once a budget is locked");
  },
});
