import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { OrganizationService } from "@/services/api";
import { MODULE_DEFINITIONS, getModuleForPage, isPageInEnabledModules } from "./moduleConfig";
import { MANDATORY_SETUP_PAGES } from "./rbac";

const ModuleAccessContext = createContext({
  enabledModules: [],
  assignedPagesByModule: {},
  pageAccess: {},
  activeMembership: null,
  isModuleEnabled: () => true,
  isPageEnabled: () => true,
  loading: true,
});

function normalizeAccessLevel(value) {
  if (value === true) return "full";
  if (value === false || value == null) return "none";

  const normalized = String(value).trim().toLowerCase();
  if (["full", "write", "edit", "manage"].includes(normalized)) return "full";
  if (["read", "read_only", "readonly", "view", "viewer"].includes(normalized)) return "read";
  return "none";
}

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

function getActiveMembership(user) {
  const memberships = Array.isArray(user?.memberships) ? user.memberships : [];
  if (memberships.length === 0) return null;
  return memberships.find((membership) => membership?.org_id === user?.org_id) || memberships[0];
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
  const [hasPageRestrictions, setHasPageRestrictions] = useState(false);
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
          setHasPageRestrictions(false);
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
          setHasPageRestrictions(false);
          setLoading(false);
          return;
        }

        setIsAdmin(false);

        const membership = getActiveMembership(user);
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
        setHasPageRestrictions(hasExplicitPagePermissions);
      } catch {
        setEnabledModules([]);
        setAssignedPagesByModule({});
        setPageAccess({});
        setActiveMembership(null);
        setHasModuleRestrictions(false);
        setHasPageRestrictions(false);
      }

      setLoading(false);
    })();
  }, [user]);

  const isModuleEnabled = (moduleKey) => {
    if (isAdmin) return true;
    if (!hasModuleRestrictions) return true;
    return enabledModules.includes(moduleKey);
  };

  const isPageEnabled = (pageName) => {
    if (isAdmin) return true;
    if (MANDATORY_SETUP_PAGES.includes(pageName)) return true;

    if (hasPageRestrictions) {
      return Boolean(pageAccess[pageName]);
    }

    if (!hasModuleRestrictions) return true;
    return isPageInEnabledModules(pageName, enabledModules);
  };

  return (
    <ModuleAccessContext.Provider
      value={{
        enabledModules,
        assignedPagesByModule,
        pageAccess,
        activeMembership,
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
