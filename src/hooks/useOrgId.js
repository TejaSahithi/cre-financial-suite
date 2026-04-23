import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";
import { resolveReadableOrgIdForUser } from "@/lib/orgUtils";
import { subscribeToActingOrgChanges } from "@/lib/actingOrg";

/**
 * Hook that returns the current org context used by shared CRUD reads/writes.
 * Super-admins only receive an org_id when they have explicitly selected an
 * acting org, unless allowSuperAdminGlobal is opted in by the caller.
 */
export default function useOrgId(options = {}) {
  const { user } = useAuth();
  const [orgId, setOrgId] = useState(undefined); // undefined = loading
  const [orgName, setOrgName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const syncOrgState = async () => {
      try {
        if (!user) {
          if (!cancelled) {
            setIsAdmin(false);
            setOrgId("__none__");
            setOrgName("");
          }
          return;
        }

        const adminUser = user.role === "admin" || user._raw_role === "super_admin";
        const resolvedOrgId = resolveReadableOrgIdForUser(user, {
          allowSuperAdminGlobal: options.allowSuperAdminGlobal === true,
        });

        if (cancelled) return;

        setIsAdmin(adminUser);
        setOrgId(resolvedOrgId);

        if (!resolvedOrgId || resolvedOrgId === "__none__") {
          setOrgName(adminUser ? "Select Organization" : "");
          return;
        }

        if (adminUser && resolvedOrgId === null) {
          setOrgName("SuperAdmin");
          return;
        }

        if (user.activeOrg?.id === resolvedOrgId && user.activeOrg?.name) {
          setOrgName(user.activeOrg.name);
          return;
        }

        try {
          const orgs = await OrganizationService.filter({ id: resolvedOrgId });
          if (!cancelled) {
            setOrgName(orgs.length > 0 ? orgs[0].name : "");
          }
        } catch {
          if (!cancelled) setOrgName("");
        }
      } catch {
        if (!cancelled) {
          setIsAdmin(false);
          setOrgId("__none__");
          setOrgName("");
        }
      }
    };

    syncOrgState();
    const unsubscribe = subscribeToActingOrgChanges(() => {
      syncOrgState();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [options.allowSuperAdminGlobal, user]);

  return { orgId, orgName, isAdmin, loading: orgId === undefined };
}
