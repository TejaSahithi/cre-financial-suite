// Integration tests for supersede_duplicate_lease against the real local
// database. Covers: consolidating a duplicate lease, refusing an
// already-approved-lease-style bypass (none exists here, this RPC is
// exactly for approved leases), idempotent rerun, and refusing to repoint
// an already-superseded lease to a different canonical without an explicit
// new call.
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

async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `supersede-lease-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function callRpc(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  return await admin.rpc(fn, args);
}

Deno.test({
  name: "supersede_duplicate_lease: marks the duplicate superseded, points to the canonical lease, is idempotent on rerun",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Supersede Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Supersede Property ${suffix}`, status: "active" });
    const canonical = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Hudson & Pine Hospitality LLC", abstract_status: "approved", status: "approved", start_date: "2026-10-01", end_date: "2030-09-30" });
    const duplicate = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Hudson & Pine Hospitality LLC", abstract_status: "approved", status: "approved" });

    const first = await callRpc(admin, "supersede_duplicate_lease", {
      p_org_id: org.id, p_duplicate_lease_id: duplicate.id, p_canonical_lease_id: canonical.id,
      p_actor_user_id: actor.userId, p_actor_email: actor.email, p_reason: "Same lease extracted twice; canonical has verified dates.",
    });
    assertNoError(first.error);
    assertEquals(first.data.status, "superseded");
    assertEquals(first.data.superseded_by_lease_id, canonical.id);
    assertEquals(first.data.already_superseded, false);

    const { data: dupRow } = await admin.from("leases").select("status, abstract_status, superseded_by_lease_id").eq("id", duplicate.id).single();
    assertEquals(dupRow!.status, "superseded");
    assertEquals(dupRow!.abstract_status, "superseded");
    assertEquals(dupRow!.superseded_by_lease_id, canonical.id);

    // Canonical lease is untouched -- no field merging happens.
    const { data: canonicalRow } = await admin.from("leases").select("status, abstract_status").eq("id", canonical.id).single();
    assertEquals(canonicalRow!.status, "approved");

    // Idempotent rerun with the same canonical -- no error, reports already_superseded.
    const second = await callRpc(admin, "supersede_duplicate_lease", {
      p_org_id: org.id, p_duplicate_lease_id: duplicate.id, p_canonical_lease_id: canonical.id,
      p_actor_user_id: actor.userId, p_actor_email: actor.email, p_reason: "rerun",
    });
    assertNoError(second.error);
    assertEquals(second.data.already_superseded, true);
  },
});

Deno.test({
  name: "supersede_duplicate_lease: refuses to repoint an already-superseded lease to a different canonical",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Supersede Org B ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Supersede Property B ${suffix}`, status: "active" });
    const canonicalA = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Tenant", abstract_status: "approved", status: "approved" });
    const canonicalB = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Tenant", abstract_status: "approved", status: "approved" });
    const duplicate = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Tenant", abstract_status: "approved", status: "approved" });

    const first = await callRpc(admin, "supersede_duplicate_lease", {
      p_org_id: org.id, p_duplicate_lease_id: duplicate.id, p_canonical_lease_id: canonicalA.id,
      p_actor_user_id: actor.userId, p_actor_email: actor.email, p_reason: "initial",
    });
    assertNoError(first.error);

    const second = await callRpc(admin, "supersede_duplicate_lease", {
      p_org_id: org.id, p_duplicate_lease_id: duplicate.id, p_canonical_lease_id: canonicalB.id,
      p_actor_user_id: actor.userId, p_actor_email: actor.email, p_reason: "conflicting repoint attempt",
    });
    assertExists(second.error);
    assertEquals(/already superseded by a different/i.test(second.error!.message), true);
  },
});
