// Feature: enterprise-readiness-hardening Phase 4 (budgeting)
// Properties:
//   1. generate-budget rejects unauthenticated requests and does not persist
//      anything (it never has — this only adds the auth gate) but still
//      succeeds (preview-only) for an authenticated caller.
//   2. compute-budget's "approve" action accepts a budget in 'reviewed'
//      status (CreateBudget.jsx's actual pre-approval status) in addition to
//      the original 'under_review', and still rejects an ineligible status
//      like 'draft'.
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

async function setUpOrgAndUser(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `budget-phase4-${suffix}@example.test`;
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
    name: `Budget Phase4 Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Budget Phase4 Tester",
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

  return { org, actorEmail, actorUserId, accessToken };
}

Deno.test({
  name: "HTTP generate-budget: rejects unauthenticated, succeeds (non-persisting) for an authenticated caller",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpOrgAndUser(admin, suffix);

    const body = {
      scope_label: "Test Property",
      budget_year: 2026,
      scope: "property",
      period: "annual",
      method: "manual",
      leases: [],
      historical_file_ids: [],
    };

    const unauthedRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
      body: JSON.stringify(body),
    });
    const unauthedBody = await unauthedRes.json();
    assertEquals(unauthedRes.status, 401, `expected 401: ${JSON.stringify(unauthedBody)}`);
    assertEquals(unauthedBody.error, true);

    const { data: budgetRowsBefore } = await admin.from("budgets").select("id");
    const countBefore = budgetRowsBefore?.length ?? 0;

    const authedRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-budget`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    const authedBody = await authedRes.json();
    assertEquals(authedRes.status, 200, `expected success: ${JSON.stringify(authedBody)}`);
    assertExists(authedBody.total_revenue);

    const { data: budgetRowsAfter } = await admin.from("budgets").select("id");
    assertEquals(budgetRowsAfter?.length ?? 0, countBefore, "generate-budget must never persist a budgets row");
  },
});

Deno.test({
  name: "HTTP compute-budget approve: accepts 'reviewed' (CreateBudget.jsx's real precondition) and still rejects 'draft'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Budget Phase4 Property ${suffix}`,
      status: "active",
    });

    const fiscalYear = 2026;

    // Minimal revenue/expense snapshots so compute-budget's own
    // generate-precondition checks are satisfied — not re-testing the
    // computation logic itself here, only the approve-precondition change.
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "revenue",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { summary: { revenue_by_type: { base_rent: 10000, other_income: 0 } } },
    });
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "expense",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { total_expenses: 4000 },
    });

    const callComputeBudget = (action: string) =>
      fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "apikey": ANON_KEY,
        },
        body: JSON.stringify({
          action,
          property_id: property.id,
          fiscal_year: fiscalYear,
          allow_generate_without_cam: true,
        }),
      });

    const generateRes = await callComputeBudget("generate");
    const generateBody = await generateRes.json();
    assertEquals(generateRes.status, 200, `expected generate to succeed: ${JSON.stringify(generateBody)}`);
    assertExists(generateBody.budget_id);

    // Attempting approve while still 'draft' must still be rejected —
    // confirms the precondition is widened, not removed.
    const prematureApproveRes = await callComputeBudget("approve");
    const prematureApproveBody = await prematureApproveRes.json();
    assertEquals(prematureApproveBody.error, true, "approve from 'draft' must still be rejected");

    // Simulate CreateBudget.jsx's "Mark as Reviewed" step, which has no
    // compute-budget equivalent action and stays a direct write.
    const { error: reviewedErr } = await admin
      .from("budgets")
      .update({ status: "reviewed" })
      .eq("id", generateBody.budget_id);
    assertNoError(reviewedErr);

    const approveRes = await callComputeBudget("approve");
    const approveBody = await approveRes.json();
    assertEquals(approveRes.status, 200, `expected approve from 'reviewed' to succeed: ${JSON.stringify(approveBody)}`);
    assertEquals(approveBody.status, "locked");

    // Locked budgets must not be regenerable — the existing protection
    // compute-budget already enforces, now the only path CreateBudget.jsx
    // uses for persistence.
    const regenerateRes = await callComputeBudget("generate");
    const regenerateBody = await regenerateRes.json();
    assertEquals(regenerateBody.error, true, "must not be able to regenerate a locked budget");
  },
});

Deno.test({
  name: "HTTP compute-budget approve: under_review must be marked reviewed before approve_and_lock",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Budget Phase4 Property B ${suffix}`,
      status: "active",
    });

    const fiscalYear = 2026;

    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "revenue",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { summary: { revenue_by_type: { base_rent: 5000, other_income: 0 } } },
    });
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "expense",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { total_expenses: 2000 },
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

    await admin.from("budgets").update({ status: "under_review" }).eq("id", generateBody.budget_id);

    const approveRes = await fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify({ action: "approve", property_id: property.id, fiscal_year: fiscalYear }),
    });
    const approveBody = await approveRes.json();
    assertEquals(approveBody.error, true, "approve from under_review must be blocked until mark_reviewed runs");

    const markReviewedRes = await fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify({ action: "mark_reviewed", property_id: property.id, fiscal_year: fiscalYear }),
    });
    const markReviewedBody = await markReviewedRes.json();
    assertEquals(markReviewedRes.status, 200, `expected mark_reviewed from under_review to succeed: ${JSON.stringify(markReviewedBody)}`);
    assertEquals(markReviewedBody.status, "reviewed");

    const approvedAfterReviewRes = await fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify({ action: "approve", property_id: property.id, fiscal_year: fiscalYear }),
    });
    const approvedAfterReviewBody = await approvedAfterReviewRes.json();
    assertEquals(approvedAfterReviewRes.status, 200, `expected approve after mark_reviewed to lock: ${JSON.stringify(approvedAfterReviewBody)}`);
    assertEquals(approvedAfterReviewBody.status, "locked");
  },
});
