import { isSuperAdmin } from '@/lib/rbac';

export function getUserRoutingState(u, p, org, members) {
  if (!u || !p) return 'Login';

  // STRICT RULE: Roles come ONLY from memberships
  if (isSuperAdmin(u)) return 'SuperAdmin';

  if (p.status === 'suspended' || org?.status === 'suspended') return 'Login';

  const activeMemberships = Array.isArray(members)
    ? members.filter((membership) => ['active', 'owner', 'approved', 'accepted'].includes(membership?.status || 'active'))
    : [];
  const isInvitedMember =
    p.onboarding_type === 'invited' ||
    activeMemberships.some((membership) => {
      const role = membership?.role;
      return role && !['super_admin', 'org_owner', 'org_admin', 'owner', 'admin'].includes(role);
    });

  if (isInvitedMember) {
    if (p.status === 'pending_approval' && activeMemberships.length === 0) return 'PendingApproval';
    if (p.first_login) return 'Welcome';

    const hasViewedDashboard = p?.dashboard_viewed || (typeof window !== 'undefined' && localStorage.getItem('dashboard_viewed') === 'true');
    if (p.status === 'active' && org?.status === 'active' && !hasViewedDashboard) return 'WelcomeAboard';
    if (p.status === 'active' && org?.status === 'active') return 'Dashboard';
    if (activeMemberships.length > 0) return 'WelcomeAboard';
    return 'PendingApproval';
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
  const hasViewedDashboard = p?.dashboard_viewed || (typeof window !== 'undefined' && localStorage.getItem('dashboard_viewed') === 'true');
  if (org?.status === 'active' && p.status === 'active' && !hasViewedDashboard) {
    return 'WelcomeAboard';
  }

  // FIRST LOGIN / PASSWORD RESET
  if (p.first_login) return 'Welcome';

  // DASHBOARD
  if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

  // FALLBACK (Default to Dashboard)
  return 'Dashboard';
}
