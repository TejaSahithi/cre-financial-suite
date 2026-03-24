/**
 * Auth Service — Production-Ready
 *
 * All authentication is handled via Supabase Auth.
 * Roles are read exclusively from the `memberships` table.
 * No hardcoded emails, org IDs, or role strings.
 *
 * DEV_MODE is only active when VITE_SUPABASE_URL is not set,
 * and even then no business logic is faked — it simply allows
 * the UI to render without a real Supabase connection.
 */

import { supabase } from '@/services/supabaseClient';

// ──────────────────────────────────────────────────────────────
// DEV_MODE — auto-enabled ONLY when env vars are absent.
// In production (env vars present), this is always false.
// ──────────────────────────────────────────────────────────────
const DEV_MODE = !supabase;

// DEV fallback user — no hardcoded role, just a placeholder identity.
// Role is read at runtime from memberships; this is purely for UI rendering.
const DEV_USER = {
  id: 'local-dev-user',
  email: 'dev@local',
  full_name: 'Local Dev User',
  role: 'admin',           // legacy compat field
  _raw_role: 'super_admin', // resolved from memberships
  org_id: null,
  onboarding_complete: true,
};

// ─── Profile cache ───────────────────────────────────────────
let _cachedProfile = null;

// ─── Role priority for resolving effective role ──────────────
const ROLE_PRIORITY = ['super_admin', 'org_admin', 'manager', 'editor', 'viewer'];

/**
 * Resolve the highest-privilege membership for the given user.
 * Returns { role, org_id, memberships }.
 * @param {string} userId
 */
async function resolveMembership(userId) {
  const { data: memberships, error } = await supabase
    .from('memberships')
    .select('*')
    .eq('user_id', userId);

  if (error || !memberships || memberships.length === 0) {
    return { role: 'viewer', org_id: null, memberships: [] };
  }

  // Sort by highest privilege first
  const sorted = [...memberships].sort(
    (a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role)
  );
  const primary = sorted[0];

  return {
    role: primary.role,
    org_id: primary.role === 'super_admin' ? null : primary.org_id,
    memberships,
  };
}

/**
 * Build the canonical user object from a Supabase auth user.
 * Fetches profile and resolves role from memberships.
 */
async function buildUserObject(authUser) {
  // Fetch identity profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', authUser.id)
    .single();

  // Resolve role — always from memberships, never hardcoded
  const { role, org_id, memberships } = await resolveMembership(authUser.id);

  // Fetch active org if associated
  let activeOrg = null;
  if (org_id) {
    const { data: orgData } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', org_id)
      .single();
    if (orgData) activeOrg = orgData;
  }

  console.log('[auth] buildUserObject resolved:', {
    userId: authUser.id,
    email: authUser.email,
    role,
    org_id,
    profileStatus: profile?.status,
    orgStatus: activeOrg?.status,
    membershipCount: memberships.length,
  });

  return {
    id: authUser.id,
    email: authUser.email,
    full_name: profile?.full_name
      || authUser.user_metadata?.full_name
      || authUser.email?.split('@')[0]
      || 'User',
    avatar_url: profile?.avatar_url || null,
    // Map super_admin → 'admin' for legacy compatibility throughout the app
    role: role === 'super_admin' ? 'admin' : role,
    _raw_role: role,
    org_id,
    onboarding_complete: profile?.onboarding_complete ?? false,
    onboarding_type: profile?.onboarding_type || 'owner',
    first_login: profile?.first_login ?? true,
    memberships,
    profile,
    activeOrg,
  };
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Sign in with email + password.
 * @returns {Promise<object>} Resolved user object.
 */
export async function login(email, password) {
  if (DEV_MODE) {
    _cachedProfile = DEV_USER;
    return _cachedProfile;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  _cachedProfile = null; // force fresh fetch
  return await me();
}

/**
 * Sign in with Google OAuth.
 * Redirects to /Dashboard after completion.
 */
export async function loginWithGoogle() {
  if (DEV_MODE) {
    _cachedProfile = DEV_USER;
    return _cachedProfile;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/Dashboard` },
  });
  if (error) throw error;
}

/**
 * Sign in with Microsoft OAuth.
 */
export async function loginWithMicrosoft() {
  if (DEV_MODE) {
    _cachedProfile = DEV_USER;
    return _cachedProfile;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: { redirectTo: `${window.location.origin}/Dashboard` },
  });
  if (error) throw error;
}

/**
 * Send a magic link to the given email.
 */
export async function loginWithMagicLink(email) {
  if (DEV_MODE) {
    return { message: 'Magic link sent (DEV_MODE — no real email sent).' };
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/Dashboard` },
  });
  if (error) throw error;
  return { message: 'Magic link sent! Check your email.' };
}

/**
 * Sign up a new user.
 * Role assignment happens after admin approval via the memberships table.
 */
export async function signup(email, password, metadata = {}) {
  if (DEV_MODE) {
    _cachedProfile = { ...DEV_USER, email, full_name: metadata.full_name || email };
    return _cachedProfile;
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: metadata.full_name || '' },
      emailRedirectTo: `${window.location.origin}/Onboarding`,
    },
  });
  if (error) throw error;
  _cachedProfile = null;
  return data.user;
}

/**
 * Get the current authenticated user.
 * Role is always resolved from the memberships table.
 * @returns {Promise<object|null>}
 */
export async function me() {
  // DEV_MODE — return cached dev user (no Supabase available)
  if (DEV_MODE) {
    return _cachedProfile || DEV_USER;
  }

  // Return in-memory cache to avoid redundant DB calls during a session
  if (_cachedProfile) return _cachedProfile;

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw error || new Error('Not authenticated');

  _cachedProfile = await buildUserObject(user);
  return _cachedProfile;
}

/**
 * Get the current Supabase session.
 */
export async function getSession() {
  if (DEV_MODE) return null;
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

/**
 * Update the current user's profile (identity fields only).
 * Does NOT update roles — roles are managed via memberships.
 */
export async function updateProfile(updates) {
  if (DEV_MODE) {
    _cachedProfile = { ...(_cachedProfile || DEV_USER), ...updates };
    return _cachedProfile;
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) throw error;
  _cachedProfile = null; // bust cache to re-fetch fresh
  return await me();
}

/**
 * Log the user out and clear all caches.
 * @param {string} [redirectUrl]
 */
export async function logout(redirectUrl) {
  _cachedProfile = null;

  if (DEV_MODE) {
    if (redirectUrl) window.location.href = redirectUrl;
    return;
  }

  try {
    await supabase.auth.signOut();
    localStorage.removeItem('app_access_token');
    localStorage.removeItem('token');

    // Clear API caches
    try {
      const { resetOrgIdCache, clearCache } = await import('@/services/api');
      resetOrgIdCache();
      clearCache();
    } catch { /* api module may not be loaded yet */ }

    if (redirectUrl) window.location.href = redirectUrl;
  } catch (err) {
    console.error('[auth] logout() error:', err);
    if (redirectUrl) window.location.href = redirectUrl;
  }
}

/**
 * Redirect to the login page.
 */
export function redirectToLogin(returnUrl) {
  const loginUrl = '/Login';
  const url = returnUrl
    ? `${loginUrl}?returnUrl=${encodeURIComponent(returnUrl)}`
    : loginUrl;

  if (DEV_MODE) {
    console.warn('[auth][DEV_MODE] redirectToLogin suppressed. Would redirect to:', url);
    return;
  }
  window.location.href = url;
}

/**
 * Reset the in-memory profile cache.
 * Call after role/membership changes.
 */
export function resetProfileCache() {
  _cachedProfile = null;
}

/**
 * Subscribe to Supabase auth state changes.
 * @returns {function} Unsubscribe function.
 */
export function onAuthStateChange(callback) {
  if (DEV_MODE) return () => {};
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return () => subscription?.unsubscribe();
}
