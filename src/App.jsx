import React, { useEffect } from 'react';
import { BrowserRouter as Router, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { PUBLIC_PAGES, MFA_BYPASS_PAGES } from '@/lib/rbac';
import DevModeBanner from '@/components/DevModeBanner';
import MFAGuard from '@/components/MFAGuard';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { pagesConfig } from '@/pages.config';

// App Modules
import AppProviders from '@/app/AppProviders';
import AppRoutes from '@/app/AppRoutes';
import LoadingScreen from '@/app/LoadingScreen';

// Hooks & Logic
import { useMfaStatus } from '@/features/auth/useMfaStatus';
import { useFirstLoginOrganization } from '@/features/onboarding/useFirstLoginOrganization';
import { getUserRoutingState } from '@/features/auth/getUserRoutingState';
import { isSuperAdmin } from '@/lib/rbac';

const { mainPage, Pages } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];

const AuthenticatedApp = () => {
  const {
    user,
    isLoadingAuth,
    isLoadingPublicSettings,
    authError,
    navigateToLogin,
    isAuthenticated,
    refreshProfile
  } = useAuth();

  const location = useLocation();
  const currentPath = location.pathname.substring(1);
  const isInviteFlowPage = currentPath === 'AcceptInvite';
  const isPublicPage = PUBLIC_PAGES.includes(currentPath) || currentPath === "" || currentPath === mainPageKey;

  // Supabase Hash Error Interceptor
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const pathNoSlash = window.location.pathname.replace(/^\//, '');
    if (pathNoSlash === 'AcceptInvite') return;

    const params = new URLSearchParams(hash.slice(1));
    const errorCode = params.get('error_code') || params.get('error');
    if (!errorCode) return;

    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const message =
      errorCode === 'otp_expired'
        ? 'Your sign-in link has expired. Please request a new one.'
        : errorCode === 'otp_disabled'
          ? 'This sign-in link is no longer valid. Please request a new one.'
          : 'Your sign-in link could not be verified. Please sign in again.';
    import('sonner').then(({ toast }) => toast.error(message, { duration: 8000 }));
    navigateToLogin();
  }, [navigateToLogin]);

  // ─── Extracted State Hooks ──────────────────────────────────────────────
  const { mfaRequired, mfaChecked, mfaNeedsEnroll, mfaError, handleMfaVerified } = useMfaStatus({
    isAuthenticated,
    user,
    refreshProfile
  });

  const { isInitializingOrg } = useFirstLoginOrganization({
    user,
    mfaChecked,
    mfaRequired,
    refreshProfile
  });

  // ─── Loading States ─────────────────────────────────────────────────────
  if (isLoadingAuth || isLoadingPublicSettings) {
    if (isPublicPage) return <AppRoutes />;
    return <LoadingScreen />;
  }

  if (isInitializingOrg) {
    if (isPublicPage || currentPath === 'Onboarding') return <AppRoutes />;
    return <LoadingScreen />;
  }

  if (isAuthenticated && !mfaChecked) {
    if (isInviteFlowPage) return <AppRoutes />;
    return <LoadingScreen />;
  }

  // ─── MFA Guard ──────────────────────────────────────────────────────────
  if (isAuthenticated && mfaError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-red-200 shadow-sm p-8 text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4 text-red-600 text-2xl">
            🔒
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Security Verification Failed</h2>
          <p className="text-sm text-slate-500 mb-6">
            We could not verify your security status. Please refresh the page to try again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] text-white font-semibold rounded-xl transition-colors"
          >
            Refresh Page
          </button>
        </div>
      </div>
    );
  }

  const isMfaBypassPage = MFA_BYPASS_PAGES.includes(currentPath);

  if (isAuthenticated && mfaRequired && !isPublicPage && !isMfaBypassPage) {
    return <MFAGuard onVerified={handleMfaVerified} needsEnroll={mfaNeedsEnroll} />;
  }

  // ─── Auth Errors ────────────────────────────────────────────────────────
  if (authError) {
    if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
    if (authError.type === 'auth_required') {
      if (isPublicPage) return <AppRoutes />;
      navigateToLogin();
      return null;
    }
  }

  // ─── Unified Routing Logic ──────────────────────────────────────────────
  if (isAuthenticated && user) {
    if (isInviteFlowPage) {
      return <AppRoutes />;
    }

    const { profile, activeOrg, memberships } = user;

    if (!profile || !memberships) {
      return <LoadingScreen />;
    }

    const targetRoute = getUserRoutingState(user, profile, activeOrg, memberships);
    const isEntryPage = currentPath === 'Login' || currentPath === 'RequestAccess' || currentPath === '';
    
    // Check if the user is a super_admin using the centralized helper
    const isSuperAdminUser = isSuperAdmin(user);

    if ((isSuperAdminUser || targetRoute === 'Dashboard') && !isEntryPage) {
      return <AppRoutes />;
    }

    if (currentPath === targetRoute) {
      return <AppRoutes />;
    }

    if (currentPath === 'PaymentSuccess' && ['Onboarding', 'PaymentSuccess'].includes(targetRoute)) {
      return <AppRoutes />;
    }

    if (currentPath !== targetRoute && !isEntryPage) {
      console.log(`[App] Invalid protected access. Redirecting to /${targetRoute}`, { currentPath, targetRoute });
      return <Navigate to={`/${targetRoute}`} replace />;
    }

    if (isEntryPage) {
      return <Navigate to={`/${targetRoute}`} replace />;
    }
  }

  return <AppRoutes />;
};

function App() {
  return (
    <>
      <DevModeBanner />
      <AppProviders>
        <Router>
          <AuthenticatedApp />
        </Router>
      </AppProviders>
    </>
  );
}

export default App;
