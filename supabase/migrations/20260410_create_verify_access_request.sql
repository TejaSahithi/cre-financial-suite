-- Creates the verify_access_request RPC function used by the signup page.
-- Callable by anon users (SECURITY DEFINER) so unauthenticated visitors
-- can check if their email has been approved before creating an account.
-- Returns only the minimum info needed: valid flag, company_name, role.

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
      'onboarding_type', CASE
        WHEN lower(replace(replace(COALESCE(v_record.role, ''), ' ', '_'), '-', '_')) IN ('admin', 'org_admin', 'super_admin', 'owner', 'organization_owner', 'admin_(landlord)', 'landlord_admin', 'admin_landlord')
          OR lower(COALESCE(v_record.role, '')) LIKE '%owner%'
          OR lower(replace(replace(COALESCE(v_record.role, ''), ' ', '_'), '-', '_')) LIKE 'admin_%'
          OR lower(replace(replace(COALESCE(v_record.role, ''), ' ', '_'), '-', '_')) LIKE '%_admin'
        THEN 'owner'
        ELSE 'member'
      END
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

-- Grant anon and authenticated users access to call this function
GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO authenticated;
