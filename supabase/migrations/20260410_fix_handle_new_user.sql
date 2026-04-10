-- Fix handle_new_user trigger to be more resilient.
-- The "Database error checking email" error from Supabase Auth happens when
-- this trigger function crashes. Common causes:
--   1. profiles.email UNIQUE violation (previous failed signup left orphan row)
--   2. Query to access_requests or invitations fails
--
-- This version:
--   - Wraps the authorization check in an EXCEPTION block
--   - Uses ON CONFLICT to handle duplicate profiles gracefully
--   - Catches and logs errors instead of crashing the signup

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_is_authorized BOOLEAN := FALSE;
BEGIN
  -- Safely check if they are an approved access_request or have an invitation
  BEGIN
    SELECT EXISTS(
      SELECT 1 FROM public.access_requests WHERE email = NEW.email AND status = 'approved'
    ) INTO v_is_authorized;

    IF NOT v_is_authorized THEN
      SELECT EXISTS(
        SELECT 1 FROM public.invitations WHERE email = NEW.email
      ) INTO v_is_authorized;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- If access_requests or invitations table doesn't exist or query fails,
    -- default to pending_approval (safe fallback)
    RAISE WARNING '[handle_new_user] Authorization check failed for %: % — defaulting to pending_approval', NEW.email, SQLERRM;
    v_is_authorized := FALSE;
  END;

  -- Upsert into profiles — handles both new and existing profile rows
  INSERT INTO public.profiles (id, email, full_name, onboarding_type, onboarding_complete, first_login, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner'),
    CASE WHEN (NEW.raw_user_meta_data->>'onboarding_type') = 'invited' THEN TRUE ELSE FALSE END,
    TRUE,
    CASE WHEN v_is_authorized THEN 'approved' ELSE 'pending_approval' END
  )
  ON CONFLICT (id) DO UPDATE
    SET
      email            = EXCLUDED.email,
      full_name        = COALESCE(EXCLUDED.full_name, profiles.full_name),
      onboarding_type  = COALESCE(EXCLUDED.onboarding_type, profiles.onboarding_type),
      status           = CASE WHEN v_is_authorized THEN 'approved' ELSE profiles.status END,
      onboarding_complete = CASE
        WHEN EXCLUDED.onboarding_type = 'invited' THEN TRUE
        ELSE profiles.onboarding_complete
      END;

  RETURN NEW;

EXCEPTION WHEN unique_violation THEN
  -- profiles.email has a UNIQUE constraint — if another auth user had this email,
  -- update the existing profile row to point to the new auth user
  RAISE WARNING '[handle_new_user] Unique violation for % — updating existing profile', NEW.email;
  UPDATE public.profiles
  SET id = NEW.id,
      full_name = COALESCE(NEW.raw_user_meta_data->>'full_name', profiles.full_name),
      onboarding_type = COALESCE(NEW.raw_user_meta_data->>'onboarding_type', profiles.onboarding_type),
      status = CASE WHEN v_is_authorized THEN 'approved' ELSE profiles.status END
  WHERE email = NEW.email;
  RETURN NEW;

WHEN OTHERS THEN
  -- Last resort: log the error but don't crash the signup
  RAISE WARNING '[handle_new_user] Unexpected error for %: %', NEW.email, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
