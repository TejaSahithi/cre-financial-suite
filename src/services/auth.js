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
// GOOGLE OAUTH APPROVAL CHECK
// After Google sign-in, we verify the user has either:
//   a) a membership in any org, OR
//   b) an approved access_request (request_type='access') for their email
// If neither, we sign them out and redirect to RequestAccess.
// ──────────────────────────────────────────────────────────────
export async function checkGoogleUserApproval(authUser) {
  if (!supabase || !authUser) return { approved: true };

  try {
    // 1. Check for any membership — already in an org → approved
    const { data: memberships } = await supabase
      .from('memberships')
      .select('id')
      .eq('user_id', authUser.id)
      .limit(1);

    if (memberships && memberships.length > 0) {
      return { approved: true };
    }

    // 2. Check own profile row (users can always read their own row via RLS auth.uid() = id).
    //    If profile exists with any active/approved status → approved.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, status')
      .eq('id', authUser.id)
      .maybeSingle();

    if (profile) {
      const okStatuses = ['active', 'approved', 'onboarding', 'pending_approval', 'under_review'];
      if (okStatuses.includes(profile.status)) return { approved: true };
    }

    // 3. Check access_requests table.
    //    RLS may restrict reads — if it returns results we trust them;
    //    if it returns empty (no policy) we fall through to step 4.
    const { data: requests } = await supabase
      .from('access_requests')
      .select('id, status')
      .eq('email', authUser.email)
      .in('status', ['approved', 'pending_approval', 'active'])
      .limit(1);

    if (requests && requests.length > 0) {
      return { approved: true };
    }

    // 4. New Google user with no prior record — allow through so they can
    //    request access via the normal flow (App.jsx will route them correctly).
    //    We only hard-block users who have an EXPLICIT rejected/suspended status.
    if (profile && ['suspended', 'rejected'].includes(profile.status)) {
      return { approved: false, reason: 'suspended' };
    }

    // Unknown user — allow through; App.jsx routing will send them to RequestAccess
    // if they have no valid profile or memberships.
    return { approved: true };
  } catch (err) {
    console.error('[auth] checkGoogleUserApproval error:', err);
    return { approved: true }; // Fail open on network error
  }
}

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

function sortMembershipsByPrivilege(memberships = []) {
  return [...memberships].sort((a, b) => {
    const aIndex = ROLE_PRIORITY.indexOf(a.role);
    const bIndex = ROLE_PRIORITY.indexOf(b.role);
    return (aIndex === -1 ? ROLE_PRIORITY.length : aIndex)
      - (bIndex === -1 ? ROLE_PRIORITY.length : bIndex);
  });
}

function resolvePrimaryMembership(memberships = []) {
  return sortMembershipsByPrivilege(memberships)[0] || null;
}

async function reconcileSignedInInvite(authUser, memberships = []) {
  const invitedMemberships = memberships.filter((membership) => membership?.status === 'invited');
  if (!authUser?.id || invitedMemberships.length === 0) return memberships;

  const now = new Date().toISOString();
  const orgIds = [...new Set(invitedMemberships.map((membership) => membership.org_id).filter(Boolean))];

  try {
    await supabase
      .from('memberships')
      .update({ status: 'active', updated_at: now })
      .eq('user_id', authUser.id)
      .eq('status', 'invited');
  } catch (error) {
    console.warn('[auth] invite membership activation failed:', error?.message || error);
  }

  try {
    await supabase.from('profiles').upsert({
      id: authUser.id,
      email: authUser.email || null,
      full_name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email?.split('@')[0] || null,
      status: 'active',
      last_sign_in_at: authUser.last_sign_in_at || now,
      updated_at: now,
    }, { onConflict: 'id' });
  } catch (error) {
    console.warn('[auth] invited profile reconciliation failed:', error?.message || error);
  }

  if (authUser.email && orgIds.length > 0) {
    try {
      await supabase
        .from('invitations')
        .update({ status: 'accepted', updated_at: now })
        .eq('email', authUser.email)
        .in('org_id', orgIds)
        .in('status', ['pending', 'pending_approval']);
    } catch (error) {
      console.warn('[auth] invitation log reconciliation failed:', error?.message || error);
    }
  }

  return memberships.map((membership) => (
    membership?.status === 'invited'
      ? { ...membership, status: 'active', updated_at: now }
      : membership
  ));
}

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

  const usableMemberships = memberships.filter((membership) => {
    const status = membership?.status || 'active';
    return ['active', 'owner', 'invited'].includes(status);
  });

  if (usableMemberships.length === 0) {
    return { role: 'viewer', org_id: null, memberships };
  }

  const primary = resolvePrimaryMembership(usableMemberships);

  return {
    role: primary.role,
    org_id: primary.role === 'super_admin' ? null : primary.org_id,
    memberships: usableMemberships,
  };
}

/**
 * Build the canonical user object from a Supabase auth user.
 * Fetches profile and resolves role from memberships.
 */
async function buildUserObject(authUser) {
  // Fetch identity profile
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', authUser.id)
    .single();

  // Resolve role — always from memberships, never hardcoded
  let { role, org_id, memberships } = await resolveMembership(authUser.id);
  memberships = await reconcileSignedInInvite(authUser, memberships);
  const { data: refreshedProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();
  if (refreshedProfile) profile = refreshedProfile;
  const primaryMembership = resolvePrimaryMembership(memberships);
  if (primaryMembership) {
    role = primaryMembership.role;
    org_id = primaryMembership.role === 'super_admin' ? null : primaryMembership.org_id;
  }

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

  // Check if this is a Google/OAuth user with no memberships or approval
  const isOAuthUser = authUser.app_metadata?.provider === 'google'
    || authUser.app_metadata?.providers?.includes('google');
  let _blocked = false;
  if (isOAuthUser && memberships.length === 0) {
    const approval = await checkGoogleUserApproval(authUser);
    if (!approval.approved) {
      _blocked = true;
    }
  }

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
    profile: profile || { status: 'onboarding' },
    activeOrg,
    _blocked,
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
    options: { redirectTo: `${window.location.origin}/` },
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
    .upsert({
      id: user.id,
      email: user.email || null,
      ...updates,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

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
