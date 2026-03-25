import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
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
} from '@/services/auth';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null);

  // Fetch the user profile from auth service
  const fetchProfile = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setIsLoadingAuth(true);
      const currentUser = await me();
      if (currentUser) {
        setUser(currentUser);
        setIsAuthenticated(true);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
      setAuthError(null);
    } catch (err) {
      console.error('[AuthContext] fetchProfile error:', err);
      setUser(null);
      setIsAuthenticated(false);
      setAuthError({
        type: 'auth_required',
        message: err.message || 'Authentication required',
      });
    } finally {
      if (showLoading) setIsLoadingAuth(false);
    }
  }, []);

  useEffect(() => {
    // Initial profile fetch
    fetchProfile(true);

    // Listen for auth state changes (sign in, sign out, token refresh)
    const unsubscribe = onAuthStateChange((event, session) => {
      console.log('[AuthContext] Auth event:', event);
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        resetProfileCache();
        fetchProfile(true);
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setIsAuthenticated(false);
        resetProfileCache();
      }
    });

    return () => unsubscribe();
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
    resetProfileCache();

    if (shouldRedirect) {
      authLogout(window.location.origin + '/Landing');
    } else {
      authLogout();
    }
  };

  const refreshProfile = async (showLoading = true) => {
    resetProfileCache();
    await fetchProfile(showLoading);
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
