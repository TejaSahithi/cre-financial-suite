DO $$
DECLARE
  v_user_id UUID;
  v_email TEXT := 'csahithi46@gmail.com';
  v_org_id UUID;
  v_org_name TEXT;
BEGIN
  SELECT id
    INTO v_user_id
    FROM auth.users
   WHERE lower(email) = lower(v_email)
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'Skipping owner state fix: No auth user found for %', v_email;
    RETURN;
  END IF;

  SELECT company_name
    INTO v_org_name
    FROM public.access_requests
   WHERE lower(email) = lower(v_email)
     AND status = 'approved'
   ORDER BY created_at DESC
   LIMIT 1;

  v_org_name := COALESCE(NULLIF(v_org_name, ''), 'My Organization');

  UPDATE auth.users
     SET raw_user_meta_data = jsonb_set(
       COALESCE(raw_user_meta_data, '{}'::jsonb),
       '{onboarding_type}',
       '"owner"'::jsonb,
       true
     )
   WHERE id = v_user_id;

  INSERT INTO public.profiles (
    id, email, full_name, onboarding_type, onboarding_complete, first_login, status
  )
  SELECT
    u.id,
    u.email,
    COALESCE(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
    'owner',
    FALSE,
    TRUE,
    'approved'
  FROM auth.users u
  WHERE u.id = v_user_id
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    onboarding_type = 'owner',
    onboarding_complete = FALSE,
    first_login = TRUE,
    status = CASE
      WHEN public.profiles.status IN ('active', 'under_review') THEN public.profiles.status
      ELSE 'approved'
    END;

  SELECT m.org_id
    INTO v_org_id
    FROM public.memberships m
   WHERE m.user_id = v_user_id
   ORDER BY m.created_at ASC NULLS LAST
   LIMIT 1;

  IF v_org_id IS NULL THEN
    INSERT INTO public.organizations (
      name, status, onboarding_step, primary_contact_email
    ) VALUES (
      v_org_name, 'onboarding', 1, v_email
    )
    RETURNING id INTO v_org_id;

    INSERT INTO public.memberships (
      user_id, org_id, role
    ) VALUES (
      v_user_id, v_org_id, 'org_admin'
    );
  ELSE
    UPDATE public.memberships
       SET role = 'org_admin'
     WHERE user_id = v_user_id
       AND org_id = v_org_id;
  END IF;

  UPDATE public.profiles
     SET onboarding_type = 'owner',
         status = CASE
           WHEN status IN ('active', 'under_review') THEN status
           ELSE 'onboarding'
         END
   WHERE id = v_user_id;
END $$;
