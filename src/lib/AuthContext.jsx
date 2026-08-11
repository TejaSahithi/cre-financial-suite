import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import {
  me,
  login as authLogin,
  loginWithGoogle as authLoginWithGoogle,
  loginWithMicrosoft as authLoginWithMicrosoft,
  loginWithMagicLink as authLoginWithMagicLink,
  signup as authSignup,
  logout as authLogout,
  redirectToLogin,
  onAuthStateChange,
  resetProfileCache,
  isSupabaseAuthCallbackHash,
} from '@/services/auth';
import { clearCache, resetOrgIdCache } from '@/services/api';
import { clearStoredActingOrgId } from '@/lib/actingOrg';

// How long to wait for a pending magic-link/OAuth callback (access_token
// present in the URL hash on mount) to actually resolve into an
// established session before treating it as a failed callback. Generous
// enough for a real network round trip, short enough not to leave a user
// stuck on a loading screen indefinitely.
const AUTH_CALLBACK_TIMEOUT_MS = 8000;

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null);
  const profileFetchRef = useRef(null);

  // Fetch the user profile from auth service
  const fetchProfile = useCallback(async (showLoading = true) => {
    if (profileFetchRef.current) {
      return profileFetchRef.current;
    }

    const request = (async () => {
    try {
      if (showLoading) setIsLoadingAuth(true);
      const currentUser = await me();
      if (currentUser) {
        // Google OAuth approval check: if user is blocked, sign them out
        if (currentUser._blocked) {
          setUser(null);
          setIsAuthenticated(false);
          setAuthError({
            type: 'oauth_not_approved',
            message: 'Your Google account is not approved for access. Please request access first.',
          });
          // Sign out silently and redirect
          await authLogout();
          window.location.href = '/RequestAccess?error=google_not_approved';
          return null;
        }
        setUser(currentUser);
        setIsAuthenticated(true);
        setAuthError(null);
        return currentUser;
      } else {
        setUser(null);
        setIsAuthenticated(false);
        setAuthError(null);
        return null;
      }
    } catch (err) {
      const isMissingSession =
        err?.name === 'AuthSessionMissingError'
        || String(err?.message || '').includes('Auth session missing');

      if (!isMissingSession) {
        console.error('[AuthContext] fetchProfile error:', err);
      }
      setUser(null);
      setIsAuthenticated(false);
      setAuthError({
        type: 'auth_required',
        message: err.message || 'Authentication required',
      });
      return null;
    } finally {
      if (showLoading) setIsLoadingAuth(false);
    }
    })();

    profileFetchRef.current = request;
    try {
      return await request;
    } finally {
      if (profileFetchRef.current === request) {
        profileFetchRef.current = null;
      }
    }
  }, []);


  useEffect(() => {
    // Initial profile fetch — show loading spinner only on first load
    fetchProfile(true);

    // ─── Magic-link / OAuth callback bookkeeping ──────────────────────────
    // If we landed with what looks like a pending auth callback (access_token
    // in the URL hash), App.jsx deliberately left that hash intact so
    // Supabase's client (detectSessionInUrl: true) can consume it. This is
    // the single place that decides when it's safe to clean the URL: only
    // once a session has actually been established from it (the SIGNED_IN /
    // INITIAL_SESSION event below), or — if that never happens — after a
    // bounded timeout, at which point the callback is treated as genuinely
    // failed and the existing auth-error UI is surfaced instead of leaving
    // the user stuck on a loading screen with a dead token in the URL.
    const pathNoSlash = window.location.pathname.replace(/^\//, '');
    const hadPendingAuthCallback =
      pathNoSlash !== 'AcceptInvite' && isSupabaseAuthCallbackHash(window.location.hash);

    const cleanCallbackHash = () => {
      if (isSupabaseAuthCallbackHash(window.location.hash)) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };

    let callbackTimeoutId = null;
    if (hadPendingAuthCallback) {
      callbackTimeoutId = window.setTimeout(() => {
        callbackTimeoutId = null;
        cleanCallbackHash();
        const message = "Your sign-in link couldn't be verified. Please sign in again.";
        setAuthError({ type: 'auth_required', message });
        import('sonner').then(({ toast }) => toast.error(message, { duration: 8000 }));
      }, AUTH_CALLBACK_TIMEOUT_MS);
    }

    // Listen for auth state changes (sign in, sign out, token refresh)
    // Use showLoading=false so subsequent auth events don't trigger the full-page spinner
    const unsubscribe = onAuthStateChange((event, session) => {
      if (import.meta.env.DEV) console.log('[AuthContext] Auth event:', event);

      if (hadPendingAuthCallback && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
        if (callbackTimeoutId) {
          window.clearTimeout(callbackTimeoutId);
          callbackTimeoutId = null;
        }
        cleanCallbackHash();
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        resetProfileCache({ preserveInFlight: true });
        resetOrgIdCache();
        clearCache();
        fetchProfile(false); // ← false: don't set isLoadingAuth=true for subsequent sign-ins
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setIsAuthenticated(false);
        clearStoredActingOrgId();
        resetProfileCache();
        resetOrgIdCache();
        clearCache();
      }
    });

    return () => {
      if (callbackTimeoutId) window.clearTimeout(callbackTimeoutId);
      unsubscribe();
    };
  }, [fetchProfile]);

  // ─── Auth actions exposed to the app ─────────────────────
  const login = async (email, password) => {
    const user = await authLogin(email, password);
    setUser(user);
    setIsAuthenticated(true);
    setAuthError(null);
    return user;
  };

  const loginWithGoogle = async () => {
    await authLoginWithGoogle();
  };

  const loginWithMicrosoft = async () => {
    await authLoginWithMicrosoft();
  };

  const loginWithMagicLink = async (email) => {
    return await authLoginWithMagicLink(email);
  };

  const signup = async (email, password, metadata) => {
    return await authSignup(email, password, metadata);
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    clearStoredActingOrgId();
    resetProfileCache();
    resetOrgIdCache();
    clearCache();

    if (shouldRedirect) {
      authLogout(window.location.origin + '/Landing');
    } else {
      authLogout();
    }
  };

  const refreshProfile = async (showLoading = false) => {
    resetProfileCache();
    resetOrgIdCache();
    clearCache();
    return await fetchProfile(showLoading);
  };

  const navigateToLogin = () => {
    redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      // Actions
      login,
      loginWithGoogle,
      loginWithMicrosoft,
      loginWithMagicLink,
      signup,
      logout,
      refreshProfile,
      navigateToLogin,
      checkAppState: fetchProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
