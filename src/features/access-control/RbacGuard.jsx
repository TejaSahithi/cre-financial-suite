import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useModuleAccess } from '@/lib/ModuleAccessContext';
import { canAccess, PUBLIC_PAGES, MANDATORY_SETUP_PAGES, isSuperAdmin } from '@/lib/rbac';
import AccessDenied from '@/components/AccessDenied';
import LayoutWrapper from '@/app/LayoutWrapper';

export default function RbacGuard({ pageName, children }) {
  const { user } = useAuth();
  const { isPageEnabled, pageAccess } = useModuleAccess();
  const permissionPageName = pageName === "AutomationReadiness" ? "Workflows" : pageName;

  if (PUBLIC_PAGES.includes(pageName) || MANDATORY_SETUP_PAGES.includes(pageName)) return children;

  if (!user) {
    return <Navigate to="/Login" replace />;
  }

  // SuperAdmin has full access to all pages across all org contexts
  if (isSuperAdmin(user)) {
    return children;
  }

  const hasExplicitPagePermissions = Object.keys(pageAccess || {}).length > 0;
  const roleAllowsPage = hasExplicitPagePermissions 
    ? Boolean(pageAccess?.[pageName] || pageAccess?.[permissionPageName])
    : canAccess(user.role, pageName, user);

  if (!roleAllowsPage) {
    return (
      <LayoutWrapper currentPageName={pageName}>
        <AccessDenied />
      </LayoutWrapper>
    );
  }

  // Module-level access check
  if (!isPageEnabled(pageName)) {
    return (
      <LayoutWrapper currentPageName={pageName}>
        <AccessDenied />
      </LayoutWrapper>
    );
  }

  return children;
}
