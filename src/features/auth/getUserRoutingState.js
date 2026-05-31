export function getUserRoutingState(u, p, org, members) {
  if (!u || !p) return 'Login';

  // STRICT RULE: Roles come ONLY from memberships
  const isSuperAdmin = members?.some(m => m.role === 'super_admin');
  if (isSuperAdmin) return 'SuperAdmin';

  if (p.status === 'suspended' || org?.status === 'suspended') return 'Login';
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

  // INVITED / AWAITING ROLE
  const hasOrgRole = members?.some((m) => m.role && m.role !== null && m.role !== "pending");
  if (!hasOrgRole && !isSuperAdmin) return "AwaitingRole";

  // WELCOME ABOARD
  if (org?.status === 'active' && p.status === 'active' && !p.dashboard_viewed) {
    return 'WelcomeAboard';
  }

  // FIRST LOGIN / PASSWORD RESET
  if (p.first_login) return 'Welcome';

  // DASHBOARD
  if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

  // FALLBACK (Safety fix: default to AwaitingRole instead of Dashboard)
  return 'AwaitingRole';
}
