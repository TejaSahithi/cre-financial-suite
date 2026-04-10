-- Fix: Owner-type signups should be auto-approved (they're creating the org, not joining one)

-- Step 1: Fix existing profiles stuck in pending_approval
UPDATE public.profiles
SET status = 'approved'
WHERE onboarding_type = 'owner'
  AND status = 'pending_approval';

-- Step 2: Update the trigger so new owner signups get 'approved' status
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_is_authorized BOOLEAN := FALSE;
BEGIN
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
      NULL;
    END;
  END IF;

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
      status           = CASE
        WHEN v_is_authorized THEN 'approved'
        WHEN COALESCE(EXCLUDED.onboarding_type, 'owner') = 'owner' THEN 'approved'
        ELSE profiles.status
      END,
      onboarding_complete = CASE
        WHEN EXCLUDED.onboarding_type = 'invited' THEN TRUE
        ELSE profiles.onboarding_complete
      END;
  EXCEPTION
    WHEN unique_violation THEN
      UPDATE public.profiles
      SET id = NEW.id,
          full_name = COALESCE(NEW.raw_user_meta_data->>'full_name', profiles.full_name),
          status = CASE
            WHEN v_is_authorized THEN 'approved'
            WHEN COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner') = 'owner' THEN 'approved'
            ELSE profiles.status
          END
      WHERE email = NEW.email;
    WHEN OTHERS THEN
      RAISE WARNING '[handle_new_user] Profile insert failed for %: %', NEW.email, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
