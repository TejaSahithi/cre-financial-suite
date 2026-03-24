import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";

/**
 * Hook that returns the current user's org_id from their membership.
 * SuperAdmins (role=admin) see ALL data (orgId = null).
 * Regular users only see data belonging to their organization.
 */
export default function useOrgId() {
  const { user } = useAuth();
  const [orgId, setOrgId] = useState(undefined); // undefined = loading
  const [orgName, setOrgName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        // SuperAdmin — sees everything
        if (user.role === "admin" || user._raw_role === "super_admin") {
          setIsAdmin(true);
          setOrgId(null); // null = no filter, see everything
          setOrgName("SuperAdmin");
          return;
        }

        // Regular user — org_id comes from membership (resolved in auth.js)
        if (user.org_id) {
          setOrgId(user.org_id);
          // Optionally fetch org name
          try {
            const orgs = await OrganizationService.filter({ id: user.org_id });
            if (orgs.length > 0) setOrgName(orgs[0].name);
          } catch { /* ignore */ }
        } else {
          setOrgId("__none__"); // No org found — show nothing
          setOrgName("");
        }
      } catch {
        setOrgId("__none__");
      }
    })();
  }, [user]);

  return { orgId, orgName, isAdmin, loading: orgId === undefined };
}