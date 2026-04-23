import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";
import { MODULE_DEFINITIONS, getModuleForPage } from "./moduleConfig";
import { MANDATORY_SETUP_PAGES } from "./rbac";
import { getActiveMembershipForUser, getPageAccessLevel as resolveUserPageAccessLevel, normalizeAccessLevel } from "./userPermissions";

const ModuleAccessContext = createContext({
  enabledModules: [],
  assignedPagesByModule: {},
  pageAccess: {},
  activeMembership: null,
  getPageAccessLevel: () => "none",
  canReadPage: () => true,
  canWritePage: () => true,
  isReadOnlyPage: () => false,
  isModuleEnabled: () => true,
  isPageEnabled: () => true,
  loading: true,
});

function coerceToObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
  }
  return {};
}

function buildAssignedPagesByModule({ pagePermissions, enabledModules, hasExplicitPagePermissions }) {
  if (hasExplicitPagePermissions) {
    return Object.entries(pagePermissions).reduce((acc, [pageName, level]) => {
      if (normalizeAccessLevel(level) === "none") return acc;
      const moduleKey = getModuleForPage(pageName);
      if (!moduleKey) return acc;
      acc[moduleKey] = acc[moduleKey] || [];
      acc[moduleKey].push(pageName);
      return acc;
    }, {});
  }

  return enabledModules.reduce((acc, moduleKey) => {
    const modulePages = MODULE_DEFINITIONS[moduleKey]?.pages || [];
    if (modulePages.length > 0) {
      acc[moduleKey] = [...modulePages];
    }
    return acc;
  }, {});
}

export function ModuleAccessProvider({ children }) {
  const { user } = useAuth();
  const [enabledModules, setEnabledModules] = useState([]);
  const [assignedPagesByModule, setAssignedPagesByModule] = useState({});
  const [pageAccess, setPageAccess] = useState({});
  const [activeMembership, setActiveMembership] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasModuleRestrictions, setHasModuleRestrictions] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        if (!user) {
          setEnabledModules([]);
          setAssignedPagesByModule({});
          setPageAccess({});
          setActiveMembership(null);
          setHasModuleRestrictions(false);
          setLoading(false);
          return;
        }

        if (user.role === "admin" || user._raw_role === "super_admin") {
          setIsAdmin(true);
          setEnabledModules([]);
          setAssignedPagesByModule({});
          setPageAccess({});
          setActiveMembership(null);
          setHasModuleRestrictions(false);
          setLoading(false);
          return;
        }

        setIsAdmin(false);

        const membership = getActiveMembershipForUser(user);
        setActiveMembership(membership);

        let orgEnabledModules = [];
        if (user.org_id) {
          const orgs = await OrganizationService.filter({ id: user.org_id });
          if (Array.isArray(orgs) && orgs.length > 0 && Array.isArray(orgs[0]?.enabled_modules)) {
            orgEnabledModules = orgs[0].enabled_modules;
          }
        }

        const rawModulePermissions = coerceToObject(membership?.module_permissions);
        const rawPagePermissions = coerceToObject(membership?.page_permissions);

        const explicitModuleKeys = Object.entries(rawModulePermissions)
          .filter(([, value]) => normalizeAccessLevel(value) !== "none")
          .map(([moduleKey]) => moduleKey);

        const normalizedPageAccess = Object.entries(rawPagePermissions).reduce((acc, [pageName, level]) => {
          const normalizedLevel = normalizeAccessLevel(level);
          if (normalizedLevel !== "none") {
            acc[pageName] = normalizedLevel;
          }
          return acc;
        }, {});

        const hasExplicitModulePermissions = Object.keys(rawModulePermissions).length > 0;
        const hasExplicitPagePermissions = Object.keys(rawPagePermissions).length > 0;
        const hasOrgRestrictions = orgEnabledModules.length > 0;

        const effectiveModules = hasExplicitModulePermissions
          ? (hasOrgRestrictions
            ? explicitModuleKeys.filter((moduleKey) => orgEnabledModules.includes(moduleKey))
            : explicitModuleKeys)
          : (hasOrgRestrictions ? orgEnabledModules : []);

        setEnabledModules(effectiveModules);
        setPageAccess(normalizedPageAccess);
        setAssignedPagesByModule(
          buildAssignedPagesByModule({
            pagePermissions: rawPagePermissions,
            enabledModules: effectiveModules,
            hasExplicitPagePermissions,
          })
        );
        setHasModuleRestrictions(hasExplicitModulePermissions || hasOrgRestrictions);
      } catch {
        setEnabledModules([]);
        setAssignedPagesByModule({});
        setPageAccess({});
        setActiveMembership(null);
        setHasModuleRestrictions(false);
      }

      setLoading(false);
    })();
  }, [user]);

  const isModuleEnabled = (moduleKey) => {
    if (isAdmin) return true;
    if (!hasModuleRestrictions) return true;
    return enabledModules.includes(moduleKey);
  };

  const getPageAccessLevel = (pageName) => {
    if (isAdmin) return "admin";
    if (MANDATORY_SETUP_PAGES.includes(pageName)) return "admin";
    return resolveUserPageAccessLevel(user, pageName);
  };

  const canReadPage = (pageName) => normalizeAccessLevel(getPageAccessLevel(pageName)) !== "none";

  const canWritePage = (pageName) => {
    const level = normalizeAccessLevel(getPageAccessLevel(pageName));
    return ["write", "approve", "admin"].includes(level);
  };

  const isReadOnlyPage = (pageName) => normalizeAccessLevel(getPageAccessLevel(pageName)) === "read";

  const isPageEnabled = (pageName) => {
    return canReadPage(pageName);
  };

  return (
    <ModuleAccessContext.Provider
      value={{
        enabledModules,
        assignedPagesByModule,
        pageAccess,
        activeMembership,
        getPageAccessLevel,
        canReadPage,
        canWritePage,
        isReadOnlyPage,
        isModuleEnabled,
        isPageEnabled,
        loading,
      }}
    >
      {children}
    </ModuleAccessContext.Provider>
  );
}

export function useModuleAccess() {
  return useContext(ModuleAccessContext);
}
