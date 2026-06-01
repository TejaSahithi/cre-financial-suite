import { isSuperAdmin } from '@/lib/rbac';

export function getUserRoutingState(u, p, org, members) {
  if (!u || !p) return 'Login';

  // STRICT RULE: Roles come ONLY from memberships
  if (isSuperAdmin(u)) return 'SuperAdmin';

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



  // WELCOME ABOARD
  if (org?.status === 'active' && p.status === 'active' && !p.dashboard_viewed) {
    return 'WelcomeAboard';
  }

  // FIRST LOGIN / PASSWORD RESET
  if (p.first_login) return 'Welcome';

  // DASHBOARD
  if (p.status === 'active' && org?.status === 'active') return 'Dashboard';

  // FALLBACK (Default to Dashboard)
  return 'Dashboard';
}
