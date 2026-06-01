import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";
import { resolveReadableOrgScopeForUser } from "@/lib/orgUtils";
import { subscribeToActingOrgChanges } from "@/lib/actingOrg";
import { isSuperAdmin } from "@/lib/rbac";

/**
 * Hook that returns the current org context used by shared CRUD reads/writes.
 * Super-admins only receive an org_id when they have explicitly selected an
 * acting org. Otherwise, their scope is "platform" and orgId is null.
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

        const scopeObj = resolveReadableOrgScopeForUser(user, options);

        if (cancelled) return;

        // "isAdmin" conceptually maps to platform scope visibility here.
        const hasPlatformScope = scopeObj.scope === "platform";
        setIsAdmin(hasPlatformScope || isSuperAdmin(user));
        
        const finalOrgId = scopeObj.scope === "none" ? "__none__" : scopeObj.orgId;
        setOrgId(finalOrgId);

        if (scopeObj.scope === "none" || finalOrgId === "__none__") {
          setOrgName(hasPlatformScope ? "Select Organization" : "");
          return;
        }

        if (hasPlatformScope && finalOrgId === null) {
          setOrgName("SuperAdmin");
          return;
        }

        if (user.activeOrg?.id === finalOrgId && user.activeOrg?.name) {
          setOrgName(user.activeOrg.name);
          return;
        }

        try {
          // Temporarily disable tracking during this fetch
          const orgs = await OrganizationService.filter({ id: finalOrgId });
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
