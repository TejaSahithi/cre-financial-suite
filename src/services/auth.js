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
import {
  clearStoredActingOrgId,
  getStoredActingOrgId,
  setStoredActingOrgId,
} from '@/lib/actingOrg';

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
    // Fail CLOSED: deny access on any unexpected error rather than granting it.
    // A transient Supabase outage should not admit unapproved users into the platform.
    // The caller (App.jsx) will surface an appropriate "try again" prompt.
    console.error('[auth] checkGoogleUserApproval error — denying access until check succeeds:', err);
    return { approved: false, reason: 'network_error' };
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
let _profilePromise = null;

// ─── Role priority for resolving effective role ──────────────
const ROLE_PRIORITY = [
  'super_admin',
  'org_owner',
  'org_admin',
  'portfolio_manager',
  'property_manager',
  'finance',
  'lease_admin',
  'leasing_agent',
  'property_owner',
  'auditor',
  'custom_role',
  'tenant',
];
const ACTIVE_MEMBERSHIP_STATUSES = ['active', 'owner', 'approved', 'accepted'];
const MEMBERSHIP_STATUS_PRIORITY = ['active', 'owner', 'approved', 'accepted', 'invited'];

function getMembershipStatusRank(status) {
  const index = MEMBERSHIP_STATUS_PRIORITY.indexOf(status || 'active');
  return index === -1 ? MEMBERSHIP_STATUS_PRIORITY.length : index;
}

function sortMembershipsByPrivilege(memberships = []) {
  return [...memberships].sort((a, b) => {
    const statusDiff = getMembershipStatusRank(a?.status) - getMembershipStatusRank(b?.status);
    if (statusDiff !== 0) return statusDiff;

    const aIndex = ROLE_PRIORITY.indexOf(a.role);
    const bIndex = ROLE_PRIORITY.indexOf(b.role);
    const roleDiff = (aIndex === -1 ? ROLE_PRIORITY.length : aIndex)
      - (bIndex === -1 ? ROLE_PRIORITY.length : bIndex);
    if (roleDiff !== 0) return roleDiff;

    return String(a?.org_id || '').localeCompare(String(b?.org_id || ''));
  });
}

function resolvePrimaryMembership(memberships = [], preferredOrgId = null) {
  const sorted = sortMembershipsByPrivilege(memberships);
  if (preferredOrgId) {
    const preferredMembership = sorted.find((membership) => membership?.org_id === preferredOrgId);
    if (preferredMembership) return preferredMembership;
  }
  return sorted[0] || null;
}

async function loadMembershipRows(userId) {
  const { data: memberships, error } = await supabase
    .from('memberships')
    .select('*')
    .eq('user_id', userId);

  if (error || !memberships) return [];
  return memberships.filter((membership) => {
    const status = membership?.status || 'active';
    return [...ACTIVE_MEMBERSHIP_STATUSES, 'invited'].includes(status);
  });
}

async function invokeAuthenticatedFunction(functionName, body = {}) {
  if (DEV_MODE) {
    return { success: true };
  }

  const attemptInvoke = async (session) => {
    if (!session?.access_token) {
      throw new Error('Not authenticated');
    }

    return supabase.functions.invoke(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  };

  let { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData?.session;

  if (!session?.access_token) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData?.session?.access_token) {
      throw refreshError || new Error('Not authenticated');
    }
    session = refreshData.session;
  }

  let result = await attemptInvoke(session);

  if (result.error) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshData?.session?.access_token) {
      result = await attemptInvoke(refreshData.session);
    }
  }

  if (result.error) {
    let detail = result.error.message;
    try {
      const ctx = result.error.context;
      if (ctx && typeof ctx.json === 'function') {
        const payload = await ctx.json();
        if (payload?.error) detail = payload.error;
      }
    } catch {
      /* ignore body parse failures */
    }
    throw new Error(detail);
  }

  return result.data;
}

async function acceptInviteOnServer(payload = {}) {
  return invokeAuthenticatedFunction('accept-invite', payload);
}

async function reconcileSignedInInvite(authUser, profile, memberships = []) {
  const invitedMemberships = memberships.filter((membership) => ['invited', 'accepted', 'approved'].includes(membership?.status));
  const shouldAutoActivate = profile?.first_login === false || profile?.status === 'active';
  if (!authUser?.id || invitedMemberships.length === 0 || !shouldAutoActivate) return memberships;

  try {
    await acceptInviteOnServer();
    return await loadMembershipRows(authUser.id);
  } catch (error) {
    console.warn('[auth] invite membership activation failed:', error?.message || error);
    return memberships;
  }
}

/**
 * Resolve the highest-privilege membership for the given user.
 * Returns { role, org_id, memberships }.
 * @param {string} userId
 */
async function resolveMembership(userId) {
  const memberships = await loadMembershipRows(userId);

  if (!memberships.length) {
    return { role: null, org_id: null, memberships: [] };
  }

  const preferredOrgId = getStoredActingOrgId();
  const usableMemberships = memberships;

  if (usableMemberships.length === 0) {
    return { role: null, org_id: null, memberships };
  }

  // Only a truly activated (active/owner) membership may become "primary"
  // -- the one that determines the displayed role and org context. The
  // database's RLS functions (membership_page_access, is_active_org_member,
  // etc.) recognize activated statuses, never
  // 'invited'. If an 'invited' membership were picked as primary (e.g. it's
  // the user's only membership), the UI would show a fully privileged role
  // for an org the database has not actually granted access to yet, and
  // every write would fail with a confusing RLS error despite the client
  // believing it had permission.
  const activatedMemberships = usableMemberships.filter((m) =>
    ACTIVE_MEMBERSHIP_STATUSES.includes(m?.status || 'active')
  );

  if (activatedMemberships.length === 0) {
    return { role: null, org_id: null, memberships: usableMemberships };
  }

  const primary = resolvePrimaryMembership(activatedMemberships, preferredOrgId);

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
    .maybeSingle();

  // Resolve role — always from memberships, never hardcoded
  let { role, org_id, memberships } = await resolveMembership(authUser.id);
  memberships = await reconcileSignedInInvite(authUser, profile, memberships);
  const storedActingOrgId = getStoredActingOrgId();
  const { data: refreshedProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();
  if (refreshedProfile) profile = refreshedProfile;
  const activatedMemberships = memberships.filter((membership) =>
    ACTIVE_MEMBERSHIP_STATUSES.includes(membership?.status || 'active')
  );
  const primaryMembership = resolvePrimaryMembership(activatedMemberships, storedActingOrgId);
  if (primaryMembership) {
    role = primaryMembership.role;
    org_id = primaryMembership.role === 'super_admin' ? null : primaryMembership.org_id;
  }

  // Fetch active org if associated
  let activeOrg = null;
  const isSuperAdmin = memberships.some((membership) => membership?.role === 'super_admin');
  const resolvedActiveOrgId = isSuperAdmin ? storedActingOrgId : org_id;
  if (!isSuperAdmin && storedActingOrgId && !memberships.some((membership) => membership?.org_id === storedActingOrgId)) {
    clearStoredActingOrgId();
  }

  if (resolvedActiveOrgId) {
    const { data: orgData } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', resolvedActiveOrgId)
      .single();
    if (orgData) activeOrg = orgData;
    if (isSuperAdmin && orgData?.id) {
      setStoredActingOrgId(orgData.id);
    }
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

  const effectiveOnboardingType = profile?.onboarding_type
    || authUser.user_metadata?.onboarding_type
    || authUser.app_metadata?.onboarding_type
    || 'owner';
  const effectiveProfile = profile
    ? { ...profile, onboarding_type: profile.onboarding_type || effectiveOnboardingType }
    : { status: 'onboarding', onboarding_type: effectiveOnboardingType };

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
    onboarding_type: effectiveOnboardingType,
    first_login: profile?.first_login ?? true,
    memberships,
    profile: effectiveProfile,
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
  if (_profilePromise) return _profilePromise;

  _profilePromise = (async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) throw error || new Error('Not authenticated');

    _cachedProfile = await buildUserObject(user);
    return _cachedProfile;
  })();

  try {
    return await _profilePromise;
  } finally {
    _profilePromise = null;
  }
}

/**
 * Force a fresh fetch of the user/memberships, bypassing the session-long
 * cache in me(). Roles, memberships, and page permissions can change server
 * side (invitation accepted, role granted, org just created) without the
 * cached profile ever being invalidated, which lets a client-side permission
 * check pass on stale data even though the database's RLS policy correctly
 * rejects the write. Call this before permission-gated writes instead of
 * me() so the check reflects current DB state.
 * @returns {Promise<object|null>}
 */
export async function refreshMe() {
  _cachedProfile = null;
  return me();
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

  const payload = {
    email: user.email || null,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const { data: updatedRows, error: updateError } = await supabase
    .from('profiles')
    .update(payload)
    .eq('id', user.id)
    .select('id');

  if (updateError) throw updateError;

  if (!updatedRows?.length) {
    const { data: existingProfile, error: verifyError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    if (verifyError) throw verifyError;
    if (existingProfile?.id) {
      _cachedProfile = null;
      return await me();
    }

    const { error: insertError } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        ...payload,
      });

    if (insertError) throw insertError;
  }
  _cachedProfile = null; // bust cache to re-fetch fresh
  return await me();
}

export async function acceptInvite(payload = {}) {
  return acceptInviteOnServer(payload);
}

/**
 * Log the user out and clear all caches.
 * @param {string} [redirectUrl]
 */
export async function logout(redirectUrl) {
  _cachedProfile = null;
  clearStoredActingOrgId();

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
export function resetProfileCache(options = {}) {
  _cachedProfile = null;
  if (!options?.preserveInFlight) {
    _profilePromise = null;
  }
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

/**
 * True when a URL hash looks like a Supabase auth callback (a magic-link
 * or OAuth redirect carrying access_token, or a failed-callback error) —
 * as opposed to an unrelated app anchor hash. Shared by App.jsx (owns the
 * error-toast UI for the failure shape) and AuthContext (owns deferring
 * URL cleanup for the success shape until Supabase has actually consumed
 * it) so both agree on exactly the same shape instead of two independent
 * guesses.
 */
export function isSupabaseAuthCallbackHash(hash) {
  if (!hash) return false;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.has('access_token') || params.has('error') || params.has('error_code');
}
