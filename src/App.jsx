import { useState, useEffect, Component } from 'react';
import { Toaster } from "@/components/ui/sonner"
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

// ─── Error Boundary ───────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⚠️</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-500 mb-6">
              {this.state.error?.message || 'An unexpected error occurred. Please refresh the page.'}
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] text-white font-semibold rounded-xl transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const publicPages = [...PUBLIC_PAGES, "AcceptInvite"];

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
    <Route path="/signin" element={<Navigate to="/Login" replace />} />
    {Object.entries(Pages).map(([path, Page]) => {
      const isMandatorySetup = ["Onboarding", "Welcome", "WelcomeAboard", "PaymentSuccess"].includes(path);
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
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaChecked, setMfaChecked] = useState(false);
  const [mfaNeedsEnroll, setMfaNeedsEnroll] = useState(false);
  const [mfaVerifiedThisSession, setMfaVerifiedThisSession] = useState(false); // skip re-check after verify

  // Detect Supabase auth errors in the URL hash (e.g. expired OTP link)
  // and redirect to Login with a toast before anything else runs.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash.replace('#', ''));
    const errorCode = params.get('error_code');
    const errorDesc = params.get('error_description');
    if (errorCode) {
      // Clear the hash so the error doesn't persist on reload
      window.history.replaceState(null, '', window.location.pathname);
      let message = 'Authentication failed. Please sign in again.';
      if (errorCode === 'otp_expired') {
        message = 'Your confirmation link has expired. Please sign in again — we\'ll send you a new one.';
      } else if (errorCode === 'otp_disabled') {
        message = 'This link has already been used. Please sign in.';
      } else if (errorDesc) {
        message = decodeURIComponent(errorDesc.replace(/\+/g, ' '));
      }
      import('sonner').then(({ toast }) => toast.error(message, { duration: 8000 }));
      navigateToLogin();
    }
  }, [navigateToLogin]);

  // Check MFA whenever auth state or user changes.
  // Skipped if MFA was already verified this session to prevent re-check loop.
  useEffect(() => {
    const checkMFA = async () => {
      if (!isAuthenticated) {
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
        setMfaChecked(true);
        return;
      }

      // If MFA was already verified this session, skip re-check entirely
      if (mfaVerifiedThisSession) {
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
        setMfaChecked(true);
        return;
      }

      try {
        const { data: { session } } = await supabase.auth.getSession();
        const provider = session?.user?.app_metadata?.provider || 'email';

        if (provider === 'google') {
          setMfaRequired(false);
          setMfaNeedsEnroll(false);
          setMfaChecked(true);
          return;
        }

        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        const currentLevel = data?.currentLevel;
        const nextLevel = data?.nextLevel;

        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const totpFactors = (factorsData?.totp || []);
        const verifiedFactors = totpFactors.filter(f => f.status === 'verified');

        if (totpFactors.length === 0) {
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else if (verifiedFactors.length > 0 && currentLevel === 'aal1' && nextLevel === 'aal2') {
          setMfaNeedsEnroll(false);
          setMfaRequired(true);
        } else if (verifiedFactors.length === 0 && totpFactors.length > 0) {
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else {
          // aal2 reached — MFA is satisfied
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
  }, [isAuthenticated, user?.id, mfaVerifiedThisSession]);

  const handleMfaVerified = async () => {
    // Mark MFA as verified immediately — prevents re-check loop when profile refreshes
    setMfaVerifiedThisSession(true);
    setMfaRequired(false);
    setMfaNeedsEnroll(false);
    setMfaChecked(true);
    await refreshProfile();
  };

  // Trigger first-login only for owner accounts that truly do not have an org yet.
  // Only runs after MFA is verified (mfaChecked=true and mfaRequired=false).
  useEffect(() => {
    const hasOrganizationContext = Boolean(
      user?.org_id ||
      user?.activeOrg?.id ||
      user?.memberships?.some((membership) => membership?.org_id)
    );

    if (
      user?.profile?.status === 'approved' &&
      user?.onboarding_type === 'owner' &&
      !hasOrganizationContext &&
      !isInitializingOrg &&
      mfaChecked &&
      !mfaRequired  // Don't run first-login until MFA is complete
    ) {
      const initOrg = async () => {
        setIsInitializingOrg(true);
        try {
          console.log('[App] Triggering first-login initialization');
          const { data, error } = await supabase.functions.invoke('first-login');
          // 401 = no valid session (e.g. expired OTP link) — don't throw, just bail silently
          if (error?.message?.includes('401') || error?.message?.includes('Unauthorized') || error?.status === 401) {
            console.warn('[App] first-login: no valid session, skipping');
            return;
          }
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
  }, [user?.activeOrg?.id, user?.memberships, user?.onboarding_type, user?.org_id, user?.profile?.status, isInitializingOrg, mfaChecked, mfaRequired, refreshProfile]);

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

  // ─── MFA Guard ────────────────────────────────────────────────────────
  // MFA is required for ALL authenticated non-public pages, INCLUDING Onboarding.
  // Flow: Confirm Email → MFA Setup → Onboarding → Payment → WelcomeAboard → Dashboard
  // Only AcceptInvite and PendingApproval bypass MFA (they have their own auth flows).
  const mfaBypassPages = ["AcceptInvite", "PendingApproval", "ResetPassword", "SecurityQuestionsSetup"];
  const isMfaBypassPage = mfaBypassPages.includes(currentPath);

  if (isAuthenticated && mfaRequired && !isPublicPage && !isMfaBypassPage) {
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
      if (p.status === 'under_review' || org?.status === 'under_review' || p.status === 'onboarding' || p.status === 'approved') {
        // If the org is ALREADY active, we should move towards Welcome/Dashboard
        if (org?.status === 'active') {
          // Keep going to WelcomeAboard/Dashboard
        } else {
          // If under_review, users should ONLY see the PaymentSuccess/Confirmation state
          if (p.status === 'under_review' || org?.status === 'under_review') {
            return 'PaymentSuccess';
          }
          return 'Onboarding';
        }
      }

      // 3. INVITED / AWAITING ROLE: user is authenticated but has no role in any org
      // This can happen if admin invited but hasn't assigned a role yet.
      const hasOrgRole = members?.some((m) => m.role && m.role !== null && m.role !== "pending");
      if (!hasOrgRole && !isSuperAdmin) return "AwaitingRole";

      // 4. WELCOME ABOARD: Show after org is activated (post-SuperAdmin approval)
      if (org?.status === 'active' && p.status === 'active' && !p.dashboard_viewed) {
        return 'WelcomeAboard';
      }

      // 5. FIRST LOGIN / PASSWORD RESET: only for users who need to set password
      if (p.first_login) return 'Welcome';

      // 6. DASHBOARD: Only when everything is active and WelcomeAboard has been seen
      if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

      return 'Dashboard';

    };

    const targetRoute = getUserRoutingState(user, profile, activeOrg, memberships);
    const isEntryPage = currentPath === 'Login' || currentPath === 'RequestAccess' || currentPath === '';
    
    const isSuperAdmin = memberships?.some(m => m.role === 'super_admin');

    // 2. Strict Enforcement Rules

    // Allow active users (or SuperAdmins) to access all permitted platform pages.
    // The targetRoute 'Dashboard' (or 'SuperAdmin') represents they belong in the suite.
    if ((isSuperAdmin || targetRoute === 'Dashboard') && !isEntryPage) {
      return <AppRoutes />;
    }

    if (currentPath === targetRoute) {
      return <AppRoutes />;
    }

    // Guard: PaymentSuccess is a valid post-payment landing page.
    // After submitting payment, the complete-onboarding edge function updates profile/org
    // status asynchronously. Until the profile refresh propagates through the auth context,
    // targetRoute may briefly read as 'Onboarding'. Forcing a redirect back would drop the
    // user back to step 1. Allow PaymentSuccess whenever the user navigated there intentionally.
    if (currentPath === 'PaymentSuccess' && ['Onboarding', 'PaymentSuccess'].includes(targetRoute)) {
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
    const criticalLockStates = ['Onboarding', 'PaymentSuccess', 'PendingApproval', 'Welcome', 'AwaitingRole'];
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
      <ErrorBoundary>
        <AuthProvider>
          <QueryClientProvider client={queryClientInstance}>
            <ModuleAccessProvider>
              <Router>
                <ErrorBoundary>
                  <AuthenticatedApp />
                </ErrorBoundary>
              </Router>
            </ModuleAccessProvider>
            <Toaster />
          </QueryClientProvider>
        </AuthProvider>
      </ErrorBoundary>
    </>
  )
}

export default App;
