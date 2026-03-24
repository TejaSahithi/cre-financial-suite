import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";
import { isPageInEnabledModules } from "./moduleConfig";

const ModuleAccessContext = createContext({
  enabledModules: [],
  isModuleEnabled: () => true,
  isPageEnabled: () => true,
  loading: true,
});

export function ModuleAccessProvider({ children }) {
  const { user } = useAuth();
  const [enabledModules, setEnabledModules] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        if (!user) {
          setLoading(false);
          return;
        }

        // SuperAdmin sees all modules
        if (user.role === "admin" || user._raw_role === "super_admin") {
          setIsAdmin(true);
          setEnabledModules([]);
          setLoading(false);
          return;
        }

        // Find org from user's membership (org_id resolved in auth.js)
        if (user.org_id) {
          const orgs = await OrganizationService.filter({ id: user.org_id });
          if (orgs.length > 0 && orgs[0].enabled_modules?.length > 0) {
            setEnabledModules(orgs[0].enabled_modules);
          }
        }
      } catch {
        // Not authenticated or error — no restrictions
      }
      setLoading(false);
    })();
  }, [user]);

  const isModuleEnabled = (moduleKey) => {
    if (isAdmin) return true;
    if (!enabledModules || enabledModules.length === 0) return true;
    return enabledModules.includes(moduleKey);
  };

  const isPageEnabled = (pageName) => {
    if (isAdmin) return true;
    if (!enabledModules || enabledModules.length === 0) return true; // no restrictions set
    return isPageInEnabledModules(pageName, enabledModules);
  };

  return (
    <ModuleAccessContext.Provider value={{ enabledModules, isModuleEnabled, isPageEnabled, loading }}>
      {children}
    </ModuleAccessContext.Provider>
  );
}

export function useModuleAccess() {
  return useContext(ModuleAccessContext);
}