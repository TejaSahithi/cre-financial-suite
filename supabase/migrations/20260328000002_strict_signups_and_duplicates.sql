-- ============================================================
-- strict_signups_and_duplicates.sql
-- 1. Adds UNIQUE constraint to demo_requests and access_requests emails
-- 2. Updates handle_new_user to enforce 'pending_approval' for unauthorized users
-- ============================================================

-- 1. Prevent duplicate demo_requests per email
ALTER TABLE public.demo_requests
DROP CONSTRAINT IF EXISTS demo_requests_email_key;
ALTER TABLE public.demo_requests
ADD CONSTRAINT demo_requests_email_key UNIQUE (email);

-- 2. Prevent duplicate access_requests per email
ALTER TABLE public.access_requests
DROP CONSTRAINT IF EXISTS access_requests_email_key;
ALTER TABLE public.access_requests
ADD CONSTRAINT access_requests_email_key UNIQUE (email);


-- 3. Modify `handle_new_user` trigger to enforce 'pending_approval'
-- Anyone can sign up via Google, but they will be routed to a "Pending Approval" page automatically
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_is_authorized BOOLEAN := FALSE;
BEGIN
  -- Check if they are already an approved access_request
  SELECT EXISTS(
    SELECT 1 FROM public.access_requests WHERE email = NEW.email AND status = 'approved'
  ) INTO v_is_authorized;

  -- Or if they have an active invitation
  IF NOT v_is_authorized THEN
    SELECT EXISTS(
      SELECT 1 FROM public.invitations WHERE email = NEW.email
    ) INTO v_is_authorized;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, onboarding_type, onboarding_complete, first_login, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner'),
    -- Invited users are already onboarded — they skip the flow
    CASE WHEN (NEW.raw_user_meta_data->>'onboarding_type') = 'invited' THEN TRUE ELSE FALSE END,
    TRUE,
    
    -- THIS IS THE FIX:
    -- If they are an approved request or invited user, move them to 'approved' to begin onboarding
    -- Otherwise, default them to 'pending_approval' where they are soft-blocked by the app UI
    CASE WHEN v_is_authorized THEN 'approved' ELSE 'pending_approval' END
  )
  ON CONFLICT (id) DO UPDATE
    SET
      full_name        = COALESCE(EXCLUDED.full_name, profiles.full_name),
      onboarding_type  = COALESCE(EXCLUDED.onboarding_type, profiles.onboarding_type),
      -- Don't downgrade existing approved profiles, but DO approve if now authorized
      status           = CASE WHEN v_is_authorized THEN 'approved' ELSE profiles.status END,
      onboarding_complete = CASE
        WHEN EXCLUDED.onboarding_type = 'invited' THEN TRUE
        ELSE profiles.onboarding_complete
      END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
