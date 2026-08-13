import { isSuperAdmin } from '@/lib/rbac';

const OWNER_ONBOARDING_ROLES = new Set(['super_admin', 'org_owner', 'org_admin', 'owner', 'admin']);

function hasViewedDashboard(profile) {
  return profile?.dashboard_viewed || (typeof window !== 'undefined' && localStorage.getItem('dashboard_viewed') === 'true');
}

export function getUserRoutingState(u, p, org, members) {
  if (!u || !p) return 'Login';

  // STRICT RULE: Roles come ONLY from memberships
  if (isSuperAdmin(u)) return 'SuperAdmin';

  if (p.status === 'suspended' || org?.status === 'suspended') return 'Login';

  const activeMemberships = Array.isArray(members)
    ? members.filter((membership) => ['active', 'owner', 'approved', 'accepted'].includes(membership?.status || 'active'))
    : [];
  const pendingInviteMemberships = Array.isArray(members)
    ? members.filter((membership) => membership?.status === 'invited')
    : [];
  const onboardingType = p.onboarding_type || u.onboarding_type || u.profile?.onboarding_type || u.user_metadata?.onboarding_type;
  const hasTeamRole = activeMemberships.some((membership) => {
    const role = membership?.role;
    return role && !OWNER_ONBOARDING_ROLES.has(role);
  });
  const isTeamInviteFlow = onboardingType === 'invited' || pendingInviteMemberships.length > 0;

  if (isTeamInviteFlow) {
    if (pendingInviteMemberships.length > 0 || activeMemberships.length === 0) return 'AcceptInvite';
    if (p.status === 'active' && org?.status === 'active' && !hasViewedDashboard(p)) return 'WelcomeAboard';
    if (p.status === 'active' && org?.status === 'active') return 'Dashboard';
    return 'WelcomeAboard';
  }

  if (hasTeamRole) {
    if (p.status === 'active' && org?.status === 'active' && !hasViewedDashboard(p)) return 'WelcomeAboard';
    if (p.status === 'active' && org?.status === 'active') return 'Dashboard';
    return 'WelcomeAboard';
  }

  if (p.status === 'pending_approval') return 'PendingApproval';

  // ONBOARDING
  if (p.status === 'under_review' || org?.status === 'under_review' || p.status === 'onboarding' || p.status === 'approved') {
    if (org?.status === 'active') {
      // Keep going to WelcomeAboard/Dashboard
    } else {
      if (p.status === 'under_review' || org?.status === 'under_review') {
        return 'PaymentSuccess';
      }
      return 'Onboarding';
    }
  }



  // WELCOME ABOARD
  if (org?.status === 'active' && p.status === 'active' && !hasViewedDashboard(p)) {
    return 'WelcomeAboard';
  }

  // FIRST LOGIN / PASSWORD RESET
  if (p.first_login) return 'Welcome';

  // DASHBOARD
  if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

  // FALLBACK (Default to Dashboard)
  return 'Dashboard';
}
