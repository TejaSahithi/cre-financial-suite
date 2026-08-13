-- Repair team invite completion visibility.
--
-- Team Management starts from memberships and enriches member rows from
-- profiles. Org admins need to see profile rows for users who belong to their
-- organization; otherwise an accepted invite can lose its visible name/email
-- after the invitation row moves from pending to accepted.

DROP POLICY IF EXISTS "profiles_select_org_admin_members" ON public.profiles;
CREATE POLICY "profiles_select_org_admin_members" ON public.profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = profiles.id
        AND public.is_org_admin(m.org_id)
    )
  );

-- If an invited member completed AcceptInvite but a previous deployment left
-- the membership in invited status, repair it so page access and Team
-- Management status both resolve as active.
UPDATE public.memberships m
SET status = 'active',
    updated_at = now()
FROM public.profiles p
WHERE p.id = m.user_id
  AND m.status = 'invited'
  AND p.onboarding_type = 'invited'
  AND (
    p.status = 'active'
    OR p.onboarding_complete = true
    OR p.first_login = false
    OR p.last_sign_in_at IS NOT NULL
  );

-- Keep invite audit state aligned with active memberships so resend/status
-- logic does not continue treating completed onboarding as pending.
UPDATE public.invitations i
SET status = 'accepted',
    updated_at = now()
FROM public.memberships m
JOIN public.profiles p ON p.id = m.user_id
WHERE i.org_id = m.org_id
  AND lower(i.email) = lower(p.email)
  AND m.status IN ('active', 'owner')
  AND i.status IN ('pending', 'pending_approval');
