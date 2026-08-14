import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";

const ROLE_LABEL_BY_SCOPE = {
  portfolio: "Portfolio Manager",
  property: "Property Manager",
};

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function getDisplayName(profile, userId) {
  return profile?.full_name || profile?.email || userId || "Assigned user";
}

export function mergeManagerAssignments(...groups) {
  const merged = [];
  const seen = new Set();

  groups.flat().filter(Boolean).forEach((manager) => {
    const key = `${manager.userId || manager.user_id}:${manager.roleLabel}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(manager);
  });

  return merged;
}

export default function useManagerAssignments({ scope, scopeIds = [], orgIds = [] }) {
  const stableScopeIds = useMemo(() => uniq(scopeIds), [scopeIds]);
  const stableOrgIds = useMemo(() => uniq(orgIds), [orgIds]);

  return useQuery({
    queryKey: ["manager-assignments", scope, stableScopeIds, stableOrgIds],
    enabled: Boolean(supabase && scope && stableScopeIds.length > 0),
    initialData: {},
    queryFn: async () => {
      let query = supabase
        .from("user_access")
        .select("user_id, org_id, scope, scope_id, role, is_active")
        .eq("scope", scope)
        .eq("is_active", true)
        .in("scope_id", stableScopeIds);

      if (stableOrgIds.length > 0) {
        query = query.in("org_id", stableOrgIds);
      }

      const { data: accessRows, error: accessError } = await query;
      if (accessError) throw accessError;
      if (!accessRows?.length) return {};

      const userIds = uniq(accessRows.map((row) => row.user_id));
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds);

      if (profileError) throw profileError;

      const profilesById = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));

      return accessRows.reduce((byScopeId, row) => {
        const profile = profilesById[row.user_id] || {};
        const roleLabel = ROLE_LABEL_BY_SCOPE[row.scope] || "Manager";
        const name = getDisplayName(profile, row.user_id);
        const manager = {
          userId: row.user_id,
          orgId: row.org_id,
          scope: row.scope,
          scopeId: row.scope_id,
          role: row.role,
          roleLabel,
          name,
          email: profile.email || "",
          label: `${name} - ${roleLabel}`,
        };

        byScopeId[row.scope_id] = [...(byScopeId[row.scope_id] || []), manager];
        return byScopeId;
      }, {});
    },
  });
}
