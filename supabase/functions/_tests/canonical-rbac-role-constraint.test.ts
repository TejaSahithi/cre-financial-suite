import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

Deno.test("canonical RBAC: generic member is not a valid writing membership role", async () => {
  const admin = adminClient();
  const suffix = crypto.randomUUID();
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: `canonical-member-negative-${suffix}@example.test`,
    password: `Pass-${suffix}!`,
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = userData.user?.id;
  assertExists(userId);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({ name: `Canonical RBAC Negative ${suffix}`, status: "active" })
    .select("id")
    .single();
  if (orgError) throw orgError;

  const { error } = await admin.from("memberships").insert({
    user_id: userId,
    org_id: org.id,
    role: "member",
    status: "active",
  });

  assertExists(error, "generic member must be rejected by canonical memberships_role_check");
  assertEquals(String(error?.code), "23514");
});