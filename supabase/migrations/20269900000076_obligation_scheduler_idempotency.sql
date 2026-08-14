-- Priority 3: autonomous obligation occurrence processing and notification
-- idempotency. This extends existing obligation and notification tables.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS recipient_key TEXT;

ALTER TABLE public.notification_deliveries
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_org_idempotency_key
  ON public.notifications (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_idempotency_key
  ON public.notification_deliveries (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.lease_obligations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lease_obligations DROP CONSTRAINT %I', v_constraint);
  END IF;

  ALTER TABLE public.lease_obligations
    ADD CONSTRAINT lease_obligations_status_check
    CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','overdue','resolved','rejected','superseded','satisfied','waived','cancelled','canceled'));
END $$;

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.lease_obligation_occurrences'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lease_obligation_occurrences DROP CONSTRAINT %I', v_constraint);
  END IF;

  ALTER TABLE public.lease_obligation_occurrences
    ADD CONSTRAINT lease_obligation_occurrences_status_check
    CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','open','completed','dismissed','satisfied','waived','cancelled','canceled'));
END $$;

INSERT INTO public.notification_event_permissions (event_type, module, required_permission, notification_type, final_org_owner_approval)
VALUES
  ('obligation.due_soon', 'lease_obligations', 'critical_dates.view', 'INFORMATIONAL', FALSE),
  ('obligation.due_today', 'lease_obligations', 'critical_dates.view', 'ACTION_REQUIRED', FALSE),
  ('obligation.overdue', 'lease_obligations', 'critical_dates.view', 'CRITICAL', FALSE)
ON CONFLICT (event_type) DO UPDATE
SET module = EXCLUDED.module,
    required_permission = EXCLUDED.required_permission,
    notification_type = EXCLUDED.notification_type,
    final_org_owner_approval = EXCLUDED.final_org_owner_approval,
    updated_at = now();

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.invoke_lease_obligation_occurrence_scheduler()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_supabase_url TEXT := NULLIF(current_setting('app.settings.supabase_url', true), '');
  v_service_role_key TEXT := NULLIF(current_setting('app.settings.service_role_key', true), '');
  v_as_of DATE := CURRENT_DATE;
  v_window_end DATE := CURRENT_DATE + INTERVAL '60 days';
  v_scheduler_run_id UUID := gen_random_uuid();
  v_org RECORD;
  v_request_id BIGINT;
  v_invoked INTEGER := 0;
BEGIN
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, new_value, user_email)
    VALUES (
      NULL,
      'lease_obligation_scheduler_run',
      v_scheduler_run_id::TEXT,
      'OBLIGATION_SCHEDULER_CONFIGURATION_MISSING',
      jsonb_build_object('missing_supabase_url', v_supabase_url IS NULL, 'missing_service_role_key', v_service_role_key IS NULL)::TEXT,
      'scheduler@system.local'
    );
    RETURN jsonb_build_object('scheduler_run_id', v_scheduler_run_id, 'status', 'configuration_missing');
  END IF;

  FOR v_org IN SELECT id FROM public.organizations WHERE COALESCE(status, 'active') IN ('active', 'trialing')
  LOOP
    SELECT net.http_post(
      url := v_supabase_url || '/functions/v1/generate-obligation-occurrences',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-service-key', v_service_role_key,
        'x-internal-org-id', v_org.id::TEXT
      ),
      body := jsonb_build_object(
        'scheduled', true,
        'run_source', 'scheduler',
        'scheduler_run_id', v_scheduler_run_id,
        'as_of_date', v_as_of,
        'window_start', v_as_of,
        'window_end', v_window_end,
        'dispatch_notifications', true,
        'retry_failed_deliveries', true,
        'reminder_milestones', jsonb_build_array(30, 14, 7, 1, 0, -1, -7, -14, -30)
      )
    ) INTO v_request_id;

    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, new_value, user_email)
    VALUES (
      v_org.id,
      'lease_obligation_scheduler_invocation',
      v_scheduler_run_id::TEXT,
      'OBLIGATION_SCHEDULER_INVOKED',
      jsonb_build_object('request_id', v_request_id, 'as_of_date', v_as_of, 'window_end', v_window_end)::TEXT,
      'scheduler@system.local'
    );

    v_invoked := v_invoked + 1;
  END LOOP;

  RETURN jsonb_build_object('scheduler_run_id', v_scheduler_run_id, 'status', 'invoked', 'org_count', v_invoked);
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lease-obligation-occurrence-scheduler') THEN
    PERFORM cron.schedule(
      'lease-obligation-occurrence-scheduler',
      '15 9 * * *',
      $schedule$SELECT public.invoke_lease_obligation_occurrence_scheduler();$schedule$
    );
  END IF;
END $$;
