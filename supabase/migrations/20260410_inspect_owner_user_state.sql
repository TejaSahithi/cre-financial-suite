SELECT
  'auth_user' AS source,
  u.id::text AS id,
  u.email,
  u.email_confirmed_at::text AS status,
  COALESCE(u.raw_user_meta_data::text, '{}') AS details
FROM auth.users u
WHERE lower(u.email) = lower('csahithi46@gmail.com')

UNION ALL

SELECT
  'profile' AS source,
  p.id::text AS id,
  p.email,
  COALESCE(p.status, 'null') AS status,
  json_build_object(
    'onboarding_type', p.onboarding_type,
    'onboarding_complete', p.onboarding_complete,
    'first_login', p.first_login,
    'dashboard_viewed', p.dashboard_viewed
  )::text AS details
FROM public.profiles p
WHERE lower(p.email) = lower('csahithi46@gmail.com')

UNION ALL

SELECT
  'access_request' AS source,
  ar.id::text AS id,
  ar.email,
  COALESCE(ar.status, 'null') AS status,
  json_build_object(
    'role', ar.role,
    'company_name', ar.company_name,
    'request_type', ar.request_type
  )::text AS details
FROM public.access_requests ar
WHERE lower(ar.email) = lower('csahithi46@gmail.com')

UNION ALL

SELECT
  'invitation' AS source,
  i.id::text AS id,
  i.email,
  COALESCE(i.status, 'null') AS status,
  json_build_object(
    'role', i.role,
    'org_id', i.org_id
  )::text AS details
FROM public.invitations i
WHERE lower(i.email) = lower('csahithi46@gmail.com')

UNION ALL

SELECT
  'membership' AS source,
  m.id::text AS id,
  p.email,
  COALESCE(m.status, 'null') AS status,
  json_build_object(
    'role', m.role,
    'org_id', m.org_id,
    'user_id', m.user_id
  )::text AS details
FROM public.memberships m
LEFT JOIN public.profiles p ON p.id = m.user_id
WHERE lower(COALESCE(p.email, '')) = lower('csahithi46@gmail.com');
