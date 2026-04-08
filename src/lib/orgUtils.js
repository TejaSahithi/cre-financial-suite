import { supabase } from "@/services/supabaseClient";

export async function resolveWritableOrgId(currentOrgId) {
  if (currentOrgId && currentOrgId !== "__none__") return currentOrgId;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user?.app_metadata?.org_id) return user.app_metadata.org_id;

    const { data: membership } = await supabase
      .from("memberships")
      .select("org_id")
      .eq("user_id", user?.id)
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) return membership.org_id;

    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();

    return org?.id || null;
  } catch {
    return null;
  }
}
