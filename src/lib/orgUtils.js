import { supabase } from "@/services/supabaseClient";

export async function resolveWritableOrgId(currentOrgId) {
  // If we have an explicit ID from the current scope/context, use it.
  if (currentOrgId && currentOrgId !== "__none__") return currentOrgId;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // 1. Check user's app_metadata (set on login for most users)
    if (user?.app_metadata?.org_id) return user.app_metadata.org_id;

    // 2. Check memberships (fallback for user-level records)
    const { data: membership } = await supabase
      .from("memberships")
      .select("org_id")
      .eq("user_id", user?.id)
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) return membership.org_id;

    // 3. Fallback for Super-Admins: Pick the first organization in the system
    // if no context was provided. This ensures the record is always saved under
    // A valid organization and is visible in most global views.
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .order('created_at', { ascending: true }) // Deterministic fallback
      .limit(1)
      .maybeSingle();

    if (org?.id) return org.id;

    console.warn("[orgUtils] Failed to resolve a writable organization ID.");
    return null;
  } catch (err) {
    console.warn("[orgUtils] Error resolving writable org ID:", err);
    return null;
  }
}
