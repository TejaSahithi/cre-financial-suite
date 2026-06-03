-- 1. Fix get_my_org_ids
CREATE OR REPLACE FUNCTION public.get_my_org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT id
  FROM public.organizations
  WHERE EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE user_id = auth.uid()
      AND role = 'super_admin'
  )
  UNION
  SELECT org_id
  FROM public.memberships
  WHERE user_id = auth.uid()
    AND org_id IS NOT NULL;
$function$;

-- 2. Fix is_org_admin
CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = check_org_id))
  );
$function$;

-- 3. Fix is_super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$function$;

-- 4. Fix delete_organization_admin (fully qualified tables)
CREATE OR REPLACE FUNCTION public.delete_organization_admin(target_org_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Delete all child records first
  DELETE FROM public.memberships        WHERE org_id = target_org_id;
  DELETE FROM public.invitations        WHERE org_id = target_org_id;
  DELETE FROM public.invoices           WHERE org_id = target_org_id;
  DELETE FROM public.portfolios         WHERE org_id = target_org_id;
  DELETE FROM public.notifications      WHERE org_id = target_org_id;
  DELETE FROM public.bulk_import_logs   WHERE org_id = target_org_id;
  -- Properties + their children cascade automatically if set up, otherwise:
  DELETE FROM public.leases             WHERE org_id = target_org_id;
  DELETE FROM public.expenses           WHERE org_id = target_org_id;
  DELETE FROM public.budgets            WHERE org_id = target_org_id;
  DELETE FROM public.vendors            WHERE org_id = target_org_id;
  DELETE FROM public.documents          WHERE org_id = target_org_id;
  DELETE FROM public.tenants            WHERE org_id = target_org_id;
  DELETE FROM public.units              WHERE org_id = target_org_id;
  DELETE FROM public.buildings          WHERE org_id = target_org_id;
  DELETE FROM public.properties         WHERE org_id = target_org_id;
  -- Finally delete the org itself
  DELETE FROM public.organizations WHERE id = target_org_id;
END;
$function$;

-- 5. Fix fn_on_lease_changed
CREATE OR REPLACE FUNCTION public.fn_on_lease_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
    days_left INT;
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value, user_email)
    VALUES (NEW.org_id, 'Lease', NEW.id::text, 
            CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END,
            COALESCE(NEW.created_by, 'system'));

    -- Expiry Notification (within 180 days)
    IF NEW.end_date IS NOT NULL THEN
        days_left := NEW.end_date - CURRENT_DATE;
        IF days_left > 0 AND days_left <= 180 THEN
            IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE type = 'lease_expiry' AND link = NEW.id::text AND is_read = FALSE) THEN
                INSERT INTO public.notifications (org_id, type, title, message, link, priority)
                VALUES (NEW.org_id, 'lease_expiry', 'Lease Expiration Alert', 
                        format('%s''s lease expires in %s days (%s). Review renewal options.', NEW.tenant_name, days_left, NEW.end_date),
                        NEW.id::text,
                        CASE WHEN days_left <= 90 THEN 'high' ELSE 'medium' END);
            END IF;
        END IF;
    END IF;

    -- Budget Ready Notification
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'budget_ready' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority)
        VALUES (NEW.org_id, 'budget_approval', 'Lease Ready for Budget',
                format('%s''s lease has been validated and is now budget-ready.', NEW.tenant_name),
                'medium');
    END IF;

    RETURN NEW;
END;
$function$;

-- 6. Fix handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
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
$function$;

-- 7. Fix prevent_org_status_update
CREATE OR REPLACE FUNCTION public.prevent_org_status_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Allow service role or super admin
  IF auth.role() = 'service_role' OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- Block any change to the status column by regular users
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Regular users cannot modify organization status directly. It must be driven by billing/admin actions.';
  END IF;

  RETURN NEW;
END;
$function$;
