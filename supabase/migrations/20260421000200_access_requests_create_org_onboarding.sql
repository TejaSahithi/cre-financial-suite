-- Approved access requests represent new organization onboarding.
-- Do not downgrade them to "member" based on the applicant's job title.

CREATE OR REPLACE FUNCTION public.verify_access_request(p_email TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record RECORD;
  v_invite RECORD;
BEGIN
  SELECT ar.company_name, ar.role, ar.status
    INTO v_record
    FROM public.access_requests ar
   WHERE ar.email = lower(trim(p_email))
     AND ar.status = 'approved'
   ORDER BY ar.created_at DESC
   LIMIT 1;

  IF v_record IS NOT NULL THEN
    RETURN json_build_object(
      'valid', true,
      'company_name', COALESCE(v_record.company_name, 'Unknown'),
      'role', COALESCE(v_record.role, 'Admin (Landlord)'),
      'source', 'access_request',
      'onboarding_type', 'owner'
    );
  END IF;

  SELECT i.org_id, o.name AS org_name, i.role
    INTO v_invite
    FROM public.invitations i
    LEFT JOIN public.organizations o ON o.id = i.org_id
   WHERE i.email = lower(trim(p_email))
     AND i.status IN ('pending', 'pending_approval')
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF v_invite IS NOT NULL THEN
    RETURN json_build_object(
      'valid', true,
      'company_name', COALESCE(v_invite.org_name, 'Your Organization'),
      'role', COALESCE(v_invite.role, 'Member'),
      'source', 'invitation',
      'onboarding_type', 'invited'
    );
  END IF;

  RETURN json_build_object(
    'valid', false,
    'message', 'Your email is not approved for account creation. Please request access first.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO authenticated;

-- Repair users who already created accounts from an approved access request
-- but were classified as member/invited before this fix.
UPDATE public.profiles p
   SET onboarding_type = 'owner',
       onboarding_complete = FALSE,
       first_login = TRUE,
       status = CASE
         WHEN p.status IN ('pending_approval', 'approved') THEN 'approved'
         ELSE p.status
       END,
       updated_at = now()
 WHERE EXISTS (
   SELECT 1
    FROM public.access_requests ar
    WHERE ar.email = lower(p.email)
      AND ar.status = 'approved'
 )
   AND NOT EXISTS (
     SELECT 1
       FROM public.memberships m
      WHERE m.user_id = p.id
   )
   AND NOT EXISTS (
     SELECT 1
    FROM public.invitations i
     WHERE i.email = lower(p.email)
        AND i.status IN ('pending', 'pending_approval')
   );
