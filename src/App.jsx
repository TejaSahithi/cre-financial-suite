import React, { useState, useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { canAccess, PUBLIC_PAGES } from '@/lib/rbac';
import AccessDenied from '@/components/AccessDenied';
import { ModuleAccessProvider, useModuleAccess } from '@/lib/ModuleAccessContext';
import DevModeBanner from '@/components/DevModeBanner';
import { supabase } from '@/services/supabaseClient';
import MFAGuard from '@/components/MFAGuard';

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const publicPages = PUBLIC_PAGES;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const RbacGuard = ({ pageName, children }) => {
  const { user } = useAuth();
  const { isPageEnabled } = useModuleAccess();
  // Public pages and loading states — allow through
  if (publicPages.includes(pageName) || !user) return children;
  if (!canAccess(user.role, pageName)) {
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
};

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={
      <LayoutWrapper currentPageName={mainPageKey}>
        <MainPage />
      </LayoutWrapper>
    } />
    {Object.entries(Pages).map(([path, Page]) => {
      const isMandatorySetup = ["Onboarding", "Welcome", "WelcomeAboard"].includes(path);
      return (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <RbacGuard pageName={path}>
              {isMandatorySetup ? (
                <Page />
              ) : (
                <LayoutWrapper currentPageName={path}>
                  <Page />
                </LayoutWrapper>
              )}
            </RbacGuard>
          }
        />
      );
    })}
    <Route path="*" element={<PageNotFound />} />
  </Routes>
);


const AuthenticatedApp = () => {
  const { user, isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin, isAuthenticated, refreshProfile } = useAuth();
  const location = useLocation();

  const [isInitializingOrg, setIsInitializingOrg] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false); // true = show MFA screen
  const [mfaChecked, setMfaChecked] = useState(false);   // true = check complete
  const [mfaNeedsEnroll, setMfaNeedsEnroll] = useState(false); // true = user has no TOTP factor, needs enrollment

  // Check MFA (Authenticator Assurance Level) whenever auth state or user changes
  // Rule: Google OAuth users SKIP MFA. Magic link / email users MUST have MFA.
  useEffect(() => {
    const checkMFA = async () => {
      if (!isAuthenticated) {
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
        setMfaChecked(true);
        return;
      }
      try {
        // Determine the auth provider from the session
        const { data: { session } } = await supabase.auth.getSession();
        const provider = session?.user?.app_metadata?.provider || 'email';

        // Google OAuth users skip MFA entirely
        if (provider === 'google') {
          setMfaRequired(false);
          setMfaNeedsEnroll(false);
          setMfaChecked(true);
          return;
        }

        // For magic link / email users: check MFA enrollment and level
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        const currentLevel = data?.currentLevel;
        const nextLevel = data?.nextLevel;

        // List enrolled factors to see if user has TOTP set up
        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const totpFactors = (factorsData?.totp || []);
        const verifiedFactors = totpFactors.filter(f => f.status === 'verified');

        if (totpFactors.length === 0) {
          // User has no TOTP enrolled at all → force enrollment
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else if (verifiedFactors.length > 0 && currentLevel === 'aal1' && nextLevel === 'aal2') {
          // TOTP exists and is verified, but session is aal1 → force verification challenge
          setMfaNeedsEnroll(false);
          setMfaRequired(true);
        } else if (verifiedFactors.length === 0 && totpFactors.length > 0) {
          // User has an unverified factor → MFAGuard will clean it up and re-enroll
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else {
          // aal2 reached
          setMfaRequired(false);
          setMfaNeedsEnroll(false);
        }
      } catch(e) {
        console.warn('[App] MFA check error:', e);
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
      }
      setMfaChecked(true);
    };
    checkMFA();
  }, [isAuthenticated, user?.id]);

  const handleMfaVerified = async () => {
    setMfaRequired(false);
    setMfaNeedsEnroll(false);
    await refreshProfile();
  };

  // Trigger first-login logic automatically based on state machine
  useEffect(() => {
    if (user?.profile?.status === 'approved' && !isInitializingOrg) {
      const initOrg = async () => {
        setIsInitializingOrg(true);
        try {
          console.log('[App] Triggering first-login initialization');
          const { data, error } = await supabase.functions.invoke('first-login');
          if (error || data?.error) throw new Error(error?.message || data?.error || 'Failed to initialize organization');
          
          await refreshProfile(); // Refresh auth state to pull down the newly minted Org and `onboarding` status
        } catch(e) {
          console.error('[App] First login init error:', e);
        } finally {
          setIsInitializingOrg(false);
        }
      };
      initOrg();
    }
  }, [user?.profile?.status]);

  // Determine if the current page is public
  const currentPath = location.pathname.substring(1); // remove leading /
  const isPublicPage = publicPages.includes(currentPath) || currentPath === "" || currentPath === mainPageKey;

  // Show loading spinner while checking auth or initializing the strict backend state (org creation)
  if (isLoadingPublicSettings || isLoadingAuth || isInitializingOrg || (isAuthenticated && !mfaChecked)) {
    if (isPublicPage && !isInitializingOrg) {
      return <AppRoutes />;
    }
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // ─── MFA Guard: intercept aal1 sessions on protected pages ───────────
  if (isAuthenticated && mfaRequired && !isPublicPage) {
    return <MFAGuard onVerified={handleMfaVerified} needsEnroll={mfaNeedsEnroll} />;
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      if (isPublicPage) {
        return <AppRoutes />;
      }
      navigateToLogin();
      return null;
    }
  }

  // ─── Unified Routing Logic ───────────────────────────────
  if (isAuthenticated && user) {
    const { profile, activeOrg, memberships } = user;

    // Loading guard: If authenticated but data hasn't arrived yet, stay on loading
    if (!profile || !memberships) {
      return (
        <div className="fixed inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
        </div>
      );
    }

    // 1. Deterministic State Machine for Routing (MEMBERSHIPS ONLY)
    const getUserRoutingState = (u, p, org, members) => {
      if (!u || !p) return 'Login';

      // STRICT RULE: Roles come ONLY from memberships
      const isSuperAdmin = members?.some(m => m.role === 'super_admin');
      if (isSuperAdmin) return 'SuperAdmin';

      if (p.status === 'suspended' || org?.status === 'suspended') return 'Login';
      if (p.status === 'pending_approval') return 'PendingApproval';

      
      // 2. ONBOARDING: Case 1 - Profile approved but Org not created yet -> Redirect to Onboarding
      // Case 2 - status is 'onboarding' (Step 1-3)
      // Case 3 - status is 'under_review' (Step 4) - show Onboarding confirmation page
      if (p.status === 'under_review' || org?.status === 'under_review') return 'Onboarding';
      if (p.status === 'approved' || p.status === 'onboarding') return 'Onboarding';

      // 3. FIRST LOGIN / PASSWORD RESET: only for invited users who need to set password
      if (p.first_login && p.onboarding_type === 'invited') return 'Welcome';

      // 4. WELCOME ABOARD: Show after org is activated (post-SuperAdmin approval)
      if (org?.status === 'active' && p.status === 'active' && p.onboarding_complete && !p.dashboard_viewed) {
        return 'WelcomeAboard';
      }

      // 5. DASHBOARD: Only when everything is active and WelcomeAboard has been seen
      if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

      return 'Login'; // Fallback
    };

    const targetRoute = getUserRoutingState(user, profile, activeOrg, memberships);
    const isEntryPage = currentPath === 'Login' || currentPath === 'RequestAccess' || currentPath === '';
    
    const isSuperAdmin = memberships?.some(m => m.role === 'super_admin');

    console.log('[DEBUG AUTH STATE]:', {
      isAuthenticated,
      hasUser: !!user,
      hasProfile: !!profile,
      profileStatus: profile?.status,
      memberships,
      isSuperAdmin,
      activeOrgStatus: activeOrg?.status,
      currentPath,
      targetRoute
    });

    // 2. Strict Enforcement Rules
    
    // Allow active users (or SuperAdmins) to access all permitted platform pages.
    // The targetRoute 'Dashboard' (or 'SuperAdmin') represents they belong in the suite.
    if ((isSuperAdmin || targetRoute === 'Dashboard') && !isEntryPage) {
      return <AppRoutes />;
    }

    if (currentPath === targetRoute) {
      return <AppRoutes />;
    }

    // Force redirect if not on the correct route
    if (currentPath !== targetRoute && !isEntryPage) {
      console.log(`[App] Invalid protected access. Redirecting to /${targetRoute}`, { currentPath, targetRoute });
      return <Navigate to={`/${targetRoute}`} replace />;
    }

    // Automatic Landing Page Redirection
    if (isEntryPage) {
      return <Navigate to={`/${targetRoute}`} replace />;
    }
    // The request said: "No page (Dashboard, Onboarding) is directly accessible. Routing must NEVER allow dashboard access before active."
    const criticalLockStates = ['Onboarding', 'PendingApproval', 'Welcome'];
    if (criticalLockStates.includes(targetRoute) && currentPath !== targetRoute) {
      console.log(`[App] Guard intercepted: Forcing target route /${targetRoute}`);
      return <Navigate to={`/${targetRoute}`} replace />;
    }
    if (isEntryPage && currentPath !== targetRoute) {
      console.log(`[App] Guard intercepted from entry: Redirecting to /${targetRoute}`);
      return <Navigate to={`/${targetRoute}`} replace />;
    }

    if (!isPublicPage && currentPath !== targetRoute) {
      console.log(`[App] Invalid protected access. Redirecting to /${targetRoute}`);
      return <Navigate to={`/${targetRoute}`} replace />;
    }
  }

  return <AppRoutes />;
};


function App() {
  return (
    <>
      <DevModeBanner />
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <ModuleAccessProvider>
            <Router>
              <AuthenticatedApp />
            </Router>
          </ModuleAccessProvider>
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </>
  )
}

export default App