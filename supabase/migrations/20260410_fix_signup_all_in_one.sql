-- ============================================================
-- ONE-SHOT FIX: Signup "Database error checking email"
-- Run this ENTIRE block in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- STEP 1: Clean up ALL orphan profiles (profiles where auth user doesn't exist)
DELETE FROM public.profiles
WHERE id NOT IN (SELECT id FROM auth.users);

-- STEP 2: Clean up any failed auth users that are unconfirmed
-- (Comment this out if you want to keep existing unconfirmed users)
-- DELETE FROM auth.users WHERE email_confirmed_at IS NULL AND created_at < now() - interval '1 hour';

-- STEP 3: Fix the handle_new_user trigger to NEVER crash signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_is_authorized BOOLEAN := FALSE;
BEGIN
  -- Safely check authorization (won't crash even if tables are missing)
  BEGIN
    SELECT EXISTS(
      SELECT 1 FROM public.access_requests
      WHERE email = NEW.email AND status = 'approved'
    ) INTO v_is_authorized;
  EXCEPTION WHEN OTHERS THEN
    v_is_authorized := FALSE;
  END;

  IF NOT v_is_authorized THEN
    BEGIN
      SELECT EXISTS(
        SELECT 1 FROM public.invitations WHERE email = NEW.email
      ) INTO v_is_authorized;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- keep v_is_authorized as FALSE
    END;
  END IF;

  -- Upsert profile — handles both new rows and orphan rows
  BEGIN
    INSERT INTO public.profiles (
      id, email, full_name, onboarding_type,
      onboarding_complete, first_login, status
    ) VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
      COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner'),
      CASE WHEN (NEW.raw_user_meta_data->>'onboarding_type') = 'invited' THEN TRUE ELSE FALSE END,
      TRUE,
      CASE
        WHEN v_is_authorized THEN 'approved'
        WHEN COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner') = 'owner' THEN 'approved'
        ELSE 'pending_approval'
      END
    )
    ON CONFLICT (id) DO UPDATE SET
      email            = EXCLUDED.email,
      full_name        = COALESCE(EXCLUDED.full_name, profiles.full_name),
      onboarding_type  = COALESCE(EXCLUDED.onboarding_type, profiles.onboarding_type),
      status           = CASE WHEN v_is_authorized THEN 'approved' ELSE profiles.status END,
      onboarding_complete = CASE
        WHEN EXCLUDED.onboarding_type = 'invited' THEN TRUE
        ELSE profiles.onboarding_complete
      END;
  EXCEPTION
    WHEN unique_violation THEN
      -- Email already exists with a different id — update it to point to new user
      UPDATE public.profiles
      SET id = NEW.id,
          full_name = COALESCE(NEW.raw_user_meta_data->>'full_name', profiles.full_name),
          status = CASE WHEN v_is_authorized THEN 'approved' ELSE profiles.status END
      WHERE email = NEW.email;
    WHEN OTHERS THEN
      RAISE WARNING '[handle_new_user] Profile insert failed for %: %', NEW.email, SQLERRM;
  END;

  -- ALWAYS return NEW so the auth user creation is NOT rolled back
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- STEP 4: Create the verify_access_request function for email validation on signup page
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
  -- Check approved access requests
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
      'role', COALESCE(v_record.role, 'Admin (Landlord)')
    );
  END IF;

  -- Check pending invitations
  SELECT i.org_id, o.name AS org_name, i.role
    INTO v_invite
    FROM public.invitations i
    LEFT JOIN public.organizations o ON o.id = i.org_id
   WHERE i.email = lower(trim(p_email))
     AND i.status = 'pending'
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF v_invite IS NOT NULL THEN
    RETURN json_build_object(
      'valid', true,
      'company_name', COALESCE(v_invite.org_name, 'Your Organization'),
      'role', COALESCE(v_invite.role, 'Member')
    );
  END IF;

  RETURN json_build_object(
    'valid', false,
    'message', 'Your email is not approved for account creation. Please request access first.'
  );
END;
$$;

-- STEP 5: Grant permissions
GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_access_request(TEXT) TO authenticated;

-- Done! Signup should now work.
