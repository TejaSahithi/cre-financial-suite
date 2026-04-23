import { supabase } from "@/services/supabaseClient";

/**
 * Resolve an org_id safe to write into.
 *
 * Returns null for super-admins with no explicit context — the caller MUST
 * surface an error in that case rather than silently pick an org. The previous
 * "first org in the system" fallback caused cross-tenant data contamination
 * (see audit finding S3).
 */
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
      .not("org_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) return membership.org_id;

    return null;
  } catch (err) {
    console.warn("[orgUtils] Error resolving writable org ID:", err);
    return null;
  }
}
