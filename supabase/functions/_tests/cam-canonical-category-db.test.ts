// CAM Enhancement and Budget Readiness Specification v2.0 — real-database
// tests for migration 039 (canonical expense_category_id, publication
// trigger, dry-run/apply remediation) and migration 040 (candidate
// enumeration and controlled ambiguity resolution).
//
// These run against the real local database, not a fake client: the entire
// point of migration 039 is that a UUID column and a TEXT label are different
// things, which a hand-built mock cannot demonstrate.
import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
async function callRpc(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  assertNoError(error);
  return data;
}
async function rpcExpectError(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  const { error } = await admin.rpc(fn, args);
  if (!error) throw new Error(`Expected ${fn} to fail, but it succeeded`);
  return error.message ?? JSON.stringify(error);
}

async function setUp(suffix: string) {
  const admin = adminClient();
  const email = `cam-cat-actor-${suffix}@example.test`;
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(userErr);
  const actorUserId = userData.user!.id;
  const org = await insertOne(admin, "organizations", { name: `Cat Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Cat Property ${suffix}`, status: "active" });
  // One unambiguous org category, plus two sharing a name to create a
  // genuinely ambiguous label (mirrors the seeded 'Insurance' pair).
  const unique = await insertOne(admin, "expense_categories", {
    org_id: org.id, category_name: `Landscaping ${suffix}`, normalized_key: `landscaping_${suffix}`,
  });
  const dupA = await insertOne(admin, "expense_categories", {
    org_id: org.id, category_name: `Ambiguous ${suffix}`, subcategory_name: "Variant A", normalized_key: `ambig_a_${suffix}`,
  });
  const dupB = await insertOne(admin, "expense_categories", {
    org_id: org.id, category_name: `Ambiguous ${suffix}`, subcategory_name: "Variant B", normalized_key: `ambig_b_${suffix}`,
  });
  return { admin, org, property, actorUserId, email, unique, dupA, dupB };
}

// --- Migration 039: publication trigger -------------------------------------

Deno.test({
  name: "039 trigger: an unambiguous category label resolves to the canonical expense_category_id at publication",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, unique } = await setUp(crypto.randomUUID());
    const row = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: unique.category_name, amount: 1000, publication_status: "published",
    });
    assertEquals(row.expense_category_id, unique.id);
    // The display label is preserved untouched (specification 8.3).
    assertEquals(row.category, unique.category_name);
  },
});

Deno.test({
  name: "039 trigger: an ambiguous category label stays NULL rather than auto-mapping to the first match",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, dupA } = await setUp(crypto.randomUUID());
    const row = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 2000, publication_status: "published",
    });
    assertEquals(row.expense_category_id, null);
    assertEquals(row.category, dupA.category_name);
  },
});

Deno.test({
  name: "039 trigger: an explicitly supplied expense_category_id is never overwritten by label resolution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, unique, dupB } = await setUp(crypto.randomUUID());
    // Label says the unambiguous category, but the caller explicitly selected
    // a different one — the explicit choice must win.
    const row = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: unique.category_name,
      expense_category_id: dupB.id, amount: 3000, publication_status: "published",
    });
    assertEquals(row.expense_category_id, dupB.id);
  },
});

Deno.test({
  name: "039 trigger: an unknown label leaves the canonical category NULL (fail-closed, never guessed)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property } = await setUp(crypto.randomUUID());
    const row = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: "No Such Category At All", amount: 500, publication_status: "published",
    });
    assertEquals(row.expense_category_id, null);
  },
});

// --- Migration 039: remediation ---------------------------------------------

Deno.test({
  name: "039 remediation: dry-run reports resolvable and unresolved rows and mutates nothing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property, dupA } = await setUp(suffix);
    // Realistic pre-migration shape: publish with a label that has no
    // matching category yet, so the trigger correctly leaves it NULL. The
    // category catalog is corrected afterwards, which is exactly when
    // remediation becomes able to resolve the historical row. (Nulling the
    // column via UPDATE would not work: the trigger fires on UPDATE too and
    // immediately re-resolves it — self-healing by design.)
    const label = `Late Added ${suffix}`;
    const resolvable = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: label, amount: 1500, publication_status: "published",
    });
    assertEquals(resolvable.expense_category_id, null);
    const ambiguous = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 2500, publication_status: "published",
    });
    const lateCategory = await insertOne(admin, "expense_categories", {
      org_id: org.id, category_name: label, normalized_key: `late_added_${suffix}`,
    });
    const unique = lateCategory;

    const report = await callRpc(admin, "remediate_cam_input_category_ids", { p_org_id: org.id, p_dry_run: true });
    assertEquals(report.dry_run, true);
    assertEquals(report.counts.inspected, 2);
    assertEquals(report.counts.resolvable, 1);
    assertEquals(report.counts.unresolved, 1);
    assertEquals(report.counts.applied, 0);

    const resolvableRow = report.rows.find((r: any) => r.source_id === resolvable.id);
    assertEquals(resolvableRow.proposed_value, unique.id);
    assertEquals(resolvableRow.confidence, "exact");
    assertEquals(resolvableRow.applied, false);
    const ambiguousRow = report.rows.find((r: any) => r.source_id === ambiguous.id);
    assertEquals(ambiguousRow.proposed_value, null);
    assertEquals(ambiguousRow.unresolved_reason, "CATEGORY_AMBIGUOUS");

    // Nothing changed on disk.
    const { data: after } = await admin.from("cam_expense_inputs").select("expense_category_id").eq("id", resolvable.id).single();
    assertEquals(after!.expense_category_id, null);
  },
});

Deno.test({
  name: "039 remediation: apply mode resolves the resolvable row and still refuses the ambiguous one",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property, dupA } = await setUp(suffix);
    const label = `Late Added ${suffix}`;
    const resolvable = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: label, amount: 1500, publication_status: "published",
    });
    assertEquals(resolvable.expense_category_id, null);
    const ambiguous = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 2500, publication_status: "published",
    });
    const unique = await insertOne(admin, "expense_categories", {
      org_id: org.id, category_name: label, normalized_key: `late_added_${suffix}`,
    });

    const report = await callRpc(admin, "remediate_cam_input_category_ids", { p_org_id: org.id, p_dry_run: false });
    assertEquals(report.counts.applied, 1);
    assertEquals(report.counts.unresolved, 1);

    const { data: fixed } = await admin.from("cam_expense_inputs").select("expense_category_id, category").eq("id", resolvable.id).single();
    assertEquals(fixed!.expense_category_id, unique.id);
    assertEquals(fixed!.category, unique.category_name); // label untouched
    const { data: stillNull } = await admin.from("cam_expense_inputs").select("expense_category_id").eq("id", ambiguous.id).single();
    assertEquals(stillNull!.expense_category_id, null);
  },
});

// --- Migration 040: candidates + controlled resolution ----------------------

Deno.test({
  name: "040 candidates: an ambiguous input is returned with both candidates and its full business context",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, dupA, dupB } = await setUp(crypto.randomUUID());
    const input = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 7500, publication_status: "published",
    });

    const report = await callRpc(admin, "get_cam_input_category_candidates", { p_org_id: org.id, p_property_id: property.id });
    assertEquals(report.unresolved_count, 1);
    assertEquals(Number(report.unresolved_amount), 7500);
    const item = report.items[0];
    assertEquals(item.cam_expense_input_id, input.id);
    assertEquals(item.unresolved_reason, "CATEGORY_AMBIGUOUS");
    assertEquals(item.candidate_count, 2);
    const ids = item.candidates.map((c: any) => c.expense_category_id).sort();
    assertEquals(ids, [dupA.id, dupB.id].sort());
    assertEquals(item.scope.property_id, property.id);
    assertExists(item.source_expense);
    assertExists(item.classification);
  },
});

Deno.test({
  name: "040 candidates: a zero-amount input is not reported (blockers must be financially material)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, dupA } = await setUp(crypto.randomUUID());
    await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 0, publication_status: "published",
    });
    const report = await callRpc(admin, "get_cam_input_category_candidates", { p_org_id: org.id, p_property_id: property.id });
    assertEquals(report.unresolved_count, 0);
  },
});

Deno.test({
  name: "040 resolution: rejects a missing reason, missing evidence, and an off-candidate category",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, actorUserId, unique, dupA } = await setUp(crypto.randomUUID());
    const input = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 9000, publication_status: "published",
    });
    const base = {
      p_org_id: org.id, p_cam_expense_input_id: input.id, p_expense_category_id: dupA.id,
      p_reason: "Reviewed lease clause 7.2", p_evidence: { lease_page: 14 }, p_actor_user_id: actorUserId,
    };

    const noReason = await rpcExpectError(admin, "resolve_cam_input_category", { ...base, p_reason: "   " });
    assertEquals(noReason.includes("business reason is required"), true);

    const noEvidence = await rpcExpectError(admin, "resolve_cam_input_category", { ...base, p_evidence: {} });
    assertEquals(noEvidence.includes("Evidence is required"), true);

    // `unique` is a real category but NOT a candidate for this label.
    const offList = await rpcExpectError(admin, "resolve_cam_input_category", { ...base, p_expense_category_id: unique.id });
    assertEquals(offList.includes("not among the candidates"), true);

    // Still unresolved after all three rejections.
    const { data: row } = await admin.from("cam_expense_inputs").select("expense_category_id").eq("id", input.id).single();
    assertEquals(row!.expense_category_id, null);
  },
});

Deno.test({
  name: "040 resolution: a valid decision applies the selected category, writes an audit record, and blocks re-resolution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, actorUserId, email, dupA, dupB } = await setUp(crypto.randomUUID());
    const input = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 12000, publication_status: "published",
    });

    const result = await callRpc(admin, "resolve_cam_input_category", {
      p_org_id: org.id, p_cam_expense_input_id: input.id, p_expense_category_id: dupB.id,
      p_reason: "Lease 12 names Variant B specifically", p_evidence: { lease_page: 14, clause: "7.2" },
      p_actor_user_id: actorUserId, p_actor_email: email,
    });
    assertEquals(result.success, true);
    assertEquals(result.resolved_expense_category_id, dupB.id);
    assertEquals(result.off_list_override, false);

    const { data: row } = await admin.from("cam_expense_inputs").select("expense_category_id, category").eq("id", input.id).single();
    assertEquals(row!.expense_category_id, dupB.id);
    assertEquals(row!.category, dupA.category_name); // display label preserved

    const { data: audit } = await admin.from("audit_logs").select("*").eq("entity_id", input.id).eq("action", "resolve_category").single();
    assertExists(audit);
    assertEquals(audit!.metadata.reason, "Lease 12 names Variant B specifically");
    assertEquals(audit!.metadata.evidence.clause, "7.2");
    assertEquals(audit!.after.expense_category_id, dupB.id);
    assertEquals(audit!.actor_user_id, actorUserId);

    // A second attempt must be refused — corrections go through supersession.
    const again = await rpcExpectError(admin, "resolve_cam_input_category", {
      p_org_id: org.id, p_cam_expense_input_id: input.id, p_expense_category_id: dupA.id,
      p_reason: "changed my mind", p_evidence: { note: "x" }, p_actor_user_id: actorUserId,
    });
    assertEquals(again.includes("already has canonical category"), true);
  },
});

Deno.test({
  name: "040 resolution: an off-candidate category is allowed only with the explicit override flag, and is recorded as such",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { admin, org, property, actorUserId, unique, dupA } = await setUp(crypto.randomUUID());
    const input = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: dupA.category_name, amount: 4000, publication_status: "published",
    });
    const result = await callRpc(admin, "resolve_cam_input_category", {
      p_org_id: org.id, p_cam_expense_input_id: input.id, p_expense_category_id: unique.id,
      p_reason: "Invoice was miscoded upstream; correct category confirmed with the vendor",
      p_evidence: { invoice: "INV-99", email: "vendor confirmation" },
      p_actor_user_id: actorUserId, p_allow_non_candidate: true,
    });
    assertEquals(result.success, true);
    assertEquals(result.off_list_override, true);

    const { data: audit } = await admin.from("audit_logs").select("metadata").eq("entity_id", input.id).eq("action", "resolve_category").single();
    assertEquals(audit!.metadata.off_list_override, true);
  },
});
