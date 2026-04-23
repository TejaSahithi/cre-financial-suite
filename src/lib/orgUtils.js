import { supabase } from "@/services/supabaseClient";
import { getStoredActingOrgId } from "@/lib/actingOrg";

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
    const storedActingOrgId = getStoredActingOrgId();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user?.app_metadata?.org_id) return user.app_metadata.org_id;

    const { data: memberships } = await supabase
      .from("memberships")
      .select("org_id, role, status")
      .eq("user_id", user?.id)
      .not("org_id", "is", null);

    const rows = Array.isArray(memberships) ? memberships : [];
    const isSuperAdmin = rows.some((membership) => membership?.role === "super_admin");
    const activeOrgIds = [...new Set(
      rows
        .filter((membership) => ["active", "owner"].includes(membership?.status || "active"))
        .map((membership) => membership?.org_id)
        .filter(Boolean),
    )];

    if (storedActingOrgId && (isSuperAdmin || activeOrgIds.includes(storedActingOrgId))) {
      return storedActingOrgId;
    }

    if (isSuperAdmin) return null;

    if (activeOrgIds.length === 1) {
      return activeOrgIds[0];
    }

    return null;
  } catch (err) {
    console.warn("[orgUtils] Error resolving writable org ID:", err);
    return null;
  }
}
