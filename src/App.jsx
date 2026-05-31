import React, { useEffect } from 'react';
import { BrowserRouter as Router, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { PUBLIC_PAGES } from '@/lib/rbac';
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

const { mainPage, Pages } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const publicPages = [...PUBLIC_PAGES, "AcceptInvite"];

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
  const isPublicPage = publicPages.includes(currentPath) || currentPath === "" || currentPath === mainPageKey;

  // ─── Supabase Hash Error Interceptor ────────────────────────────────────
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const pathNoSlash = window.location.pathname.replace(/^\//, '');
    const params = new URLSearchParams(hash.replace('#', ''));
    const errorCode = params.get('error_code');
    const errorDesc = params.get('error_description');

    if (errorCode) {
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
    } else if (pathNoSlash !== 'AcceptInvite') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
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

  const mfaBypassPages = ["AcceptInvite", "PendingApproval", "ResetPassword", "SecurityQuestionsSetup"];
  const isMfaBypassPage = mfaBypassPages.includes(currentPath);

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
    const { profile, activeOrg, memberships } = user;

    if (!profile || !memberships) {
      return <LoadingScreen />;
    }

    const targetRoute = getUserRoutingState(user, profile, activeOrg, memberships);
    const isEntryPage = currentPath === 'Login' || currentPath === 'RequestAccess' || currentPath === '';
    const isSuperAdmin = memberships?.some(m => m.role === 'super_admin');

    if ((isSuperAdmin || targetRoute === 'Dashboard') && !isEntryPage) {
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
      <AppProviders>
        <Router>
          <AuthenticatedApp />
        </Router>
      </AppProviders>
    </>
  );
}

export default App;
