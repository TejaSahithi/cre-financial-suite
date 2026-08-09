-- Enterprise role-based notifications and approval delivery tracking.
-- Extends the existing notifications table instead of replacing legacy rows.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS module TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id UUID,
  ADD COLUMN IF NOT EXISTS portfolio_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notification_type TEXT,
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS requires_action BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

UPDATE public.notifications
SET organization_id = org_id
WHERE organization_id IS NULL
  AND org_id IS NOT NULL;

UPDATE public.notifications
SET event_type = COALESCE(event_type, type),
    notification_type = COALESCE(notification_type,
      CASE
        WHEN priority = 'high' THEN 'ACTION_REQUIRED'
        WHEN type IN ('warning', 'lease_expiry', 'cam_variance') THEN 'WARNING'
        WHEN type IN ('success') THEN 'APPROVED'
        ELSE 'INFORMATIONAL'
      END),
    action_url = COALESCE(action_url, link),
    read_at = CASE WHEN is_read = TRUE AND read_at IS NULL THEN COALESCE(updated_at, created_at, now()) ELSE read_at END
WHERE event_type IS NULL
   OR notification_type IS NULL
   OR action_url IS NULL
   OR (is_read = TRUE AND read_at IS NULL);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES public.notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sms_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

CREATE TABLE IF NOT EXISTS public.notification_event_permissions (
  event_type TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  final_org_owner_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.notification_event_permissions (event_type, module, required_permission, notification_type, final_org_owner_approval)
VALUES
  ('critical_date.due_soon', 'critical_dates', 'critical_dates.view', 'INFORMATIONAL', FALSE),
  ('critical_date.due_today', 'critical_dates', 'critical_dates.view', 'INFORMATIONAL', FALSE),
  ('critical_date.overdue', 'critical_dates', 'critical_dates.view', 'CRITICAL', FALSE),
  ('portfolio.created', 'portfolio', 'portfolio.view', 'INFORMATIONAL', FALSE),
  ('portfolio.manager_assigned', 'portfolio', 'portfolio.manage', 'ACTION_REQUIRED', FALSE),
  ('property.created', 'property', 'property.view', 'INFORMATIONAL', FALSE),
  ('building.created', 'property', 'property.view', 'INFORMATIONAL', FALSE),
  ('property.manager_assigned', 'property', 'property.manage', 'ACTION_REQUIRED', FALSE),
  ('property.bulk_import_completed', 'property', 'property.view', 'INFORMATIONAL', FALSE),
  ('property.bulk_import_failed', 'property', 'property.manage', 'ACTION_REQUIRED', FALSE),
  ('lease.uploaded', 'lease', 'lease.view', 'INFORMATIONAL', FALSE),
  ('lease.extraction_completed', 'lease', 'lease.view', 'INFORMATIONAL', FALSE),
  ('lease.review_required', 'lease', 'lease.review', 'ACTION_REQUIRED', FALSE),
  ('lease.ready_for_approval', 'lease', 'lease.approve', 'APPROVAL_REQUIRED', FALSE),
  ('lease.pm_approved', 'lease', 'lease.view', 'INFORMATIONAL', FALSE),
  ('lease.asset_owner_approval_required', 'lease', 'lease.approve', 'APPROVAL_REQUIRED', FALSE),
  ('lease.org_owner_approval_required', 'lease', 'lease.approve', 'APPROVAL_REQUIRED', FALSE),
  ('lease.approved', 'lease', 'lease.view', 'APPROVED', FALSE),
  ('lease.rejected', 'lease', 'lease.view', 'REJECTED', FALSE),
  ('lease.correction_required', 'lease', 'lease.edit', 'CORRECTION_REQUIRED', FALSE),
  ('expense.submitted', 'expense', 'expense.view', 'INFORMATIONAL', FALSE),
  ('expense.review_required', 'expense', 'expense.review', 'ACTION_REQUIRED', FALSE),
  ('expense.final_approval_required', 'expense', 'expense.approve', 'APPROVAL_REQUIRED', TRUE),
  ('expense.approved', 'expense', 'expense.view', 'APPROVED', FALSE),
  ('expense.rejected', 'expense', 'expense.view', 'REJECTED', FALSE),
  ('cam.eligible', 'cam', 'cam.view', 'INFORMATIONAL', FALSE),
  ('cam.calculation_generated', 'cam', 'cam.review', 'ACTION_REQUIRED', FALSE),
  ('cam.review_required', 'cam', 'cam.review', 'ACTION_REQUIRED', FALSE),
  ('cam.final_approval_required', 'cam', 'cam.approve', 'APPROVAL_REQUIRED', TRUE),
  ('cam.approved', 'cam', 'cam.view', 'APPROVED', FALSE),
  ('cam.reconciliation_ready', 'cam', 'cam.view', 'INFORMATIONAL', FALSE),
  ('budget.generated', 'budget', 'budget.view', 'INFORMATIONAL', FALSE),
  ('budget.review_required', 'budget', 'budget.review', 'ACTION_REQUIRED', FALSE),
  ('budget.final_approval_required', 'budget', 'budget.approve', 'APPROVAL_REQUIRED', TRUE),
  ('budget.approved', 'budget', 'budget.view', 'APPROVED', FALSE),
  ('budget.rejected', 'budget', 'budget.edit', 'CORRECTION_REQUIRED', FALSE)
ON CONFLICT (event_type) DO UPDATE
SET module = EXCLUDED.module,
    required_permission = EXCLUDED.required_permission,
    notification_type = EXCLUDED.notification_type,
    final_org_owner_approval = EXCLUDED.final_org_owner_approval,
    updated_at = now();

CREATE INDEX IF NOT EXISTS idx_notifications_org_recipient_read
  ON public.notifications(org_id, recipient_user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_event_entity
  ON public.notifications(event_type, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notifications_scope
  ON public.notifications(org_id, portfolio_id, property_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
  ON public.notification_deliveries(notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_status
  ON public.notification_deliveries(channel, status);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_org
  ON public.notification_preferences(user_id, org_id);

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
    OR recipient_user_id = auth.uid()
    OR (
      recipient_user_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.org_id = notifications.org_id
      )
    )
  );

DROP POLICY IF EXISTS "notifications_update" ON public.notifications;
CREATE POLICY "notifications_update" ON public.notifications
  FOR UPDATE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
    OR recipient_user_id = auth.uid()
    OR (
      recipient_user_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.org_id = notifications.org_id
      )
    )
  );

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_event_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_deliveries_select" ON public.notification_deliveries;
CREATE POLICY "notification_deliveries_select" ON public.notification_deliveries
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.notifications n
      JOIN public.memberships m ON m.org_id = n.org_id
      WHERE n.id = notification_deliveries.notification_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "notification_deliveries_insert" ON public.notification_deliveries;
CREATE POLICY "notification_deliveries_insert" ON public.notification_deliveries
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.id = notification_deliveries.notification_id
        AND public.can_write_org_data(n.org_id)
    )
  );

DROP POLICY IF EXISTS "notification_deliveries_update" ON public.notification_deliveries;
CREATE POLICY "notification_deliveries_update" ON public.notification_deliveries
  FOR UPDATE USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.id = notification_deliveries.notification_id
        AND public.can_write_org_data(n.org_id)
    )
  );

DROP POLICY IF EXISTS "notification_preferences_select" ON public.notification_preferences;
CREATE POLICY "notification_preferences_select" ON public.notification_preferences
  FOR SELECT USING (
    public.is_super_admin()
    OR user_id = auth.uid()
    OR public.is_org_admin(org_id)
  );

DROP POLICY IF EXISTS "notification_preferences_insert" ON public.notification_preferences;
CREATE POLICY "notification_preferences_insert" ON public.notification_preferences
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR user_id = auth.uid()
    OR public.is_org_admin(org_id)
  );

DROP POLICY IF EXISTS "notification_preferences_update" ON public.notification_preferences;
CREATE POLICY "notification_preferences_update" ON public.notification_preferences
  FOR UPDATE USING (
    public.is_super_admin()
    OR user_id = auth.uid()
    OR public.is_org_admin(org_id)
  )
  WITH CHECK (
    public.is_super_admin()
    OR user_id = auth.uid()
    OR public.is_org_admin(org_id)
  );

DROP POLICY IF EXISTS "notification_event_permissions_select" ON public.notification_event_permissions;
CREATE POLICY "notification_event_permissions_select" ON public.notification_event_permissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE OR REPLACE FUNCTION public.can_approve_notification_event(
  p_org_id UUID,
  p_event_type TEXT,
  p_portfolio_id UUID DEFAULT NULL,
  p_property_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_permission TEXT;
  v_module TEXT;
  v_action TEXT;
  v_final_owner_required BOOLEAN;
  v_membership public.memberships%ROWTYPE;
  v_scope_ok BOOLEAN := FALSE;
  v_permission_ok BOOLEAN := FALSE;
  v_caps JSONB;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_event_type IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT required_permission, final_org_owner_approval
  INTO v_permission, v_final_owner_required
  FROM public.notification_event_permissions
  WHERE event_type = p_event_type;

  IF v_permission IS NULL THEN
    RETURN FALSE;
  END IF;

  v_module := split_part(v_permission, '.', 1);
  v_action := split_part(v_permission, '.', 2);

  SELECT *
  INTO v_membership
  FROM public.memberships
  WHERE user_id = auth.uid()
    AND org_id = p_org_id
    AND COALESCE(status, 'active') IN ('active', 'owner', 'approved')
  LIMIT 1;

  IF v_membership.user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_final_owner_required
     AND NOT (v_membership.role IN ('owner', 'org_owner') OR COALESCE(v_membership.status, '') = 'owner') THEN
    RETURN FALSE;
  END IF;

  IF v_membership.role IN ('owner', 'org_owner', 'org_admin', 'super_admin') OR COALESCE(v_membership.status, '') = 'owner' THEN
    v_permission_ok := TRUE;
    v_scope_ok := TRUE;
  END IF;

  v_caps := COALESCE(v_membership.capabilities, '{}'::jsonb);

  IF NOT v_permission_ok THEN
    v_permission_ok :=
      COALESCE((v_caps #>> ARRAY['permissions', v_module, v_action])::BOOLEAN, FALSE)
      OR COALESCE((v_caps #>> ARRAY['notification_permissions', v_module, v_action])::BOOLEAN, FALSE)
      OR COALESCE((v_caps #>> ARRAY['custom_permissions', v_module, v_action])::BOOLEAN, FALSE);
  END IF;

  IF NOT v_permission_ok THEN
    v_permission_ok :=
      (v_membership.role IN ('property_manager', 'manager')
        AND v_module IN ('portfolio', 'property', 'lease', 'expense', 'cam', 'budget', 'critical_dates')
        AND v_action IN ('view', 'create', 'edit', 'review', 'manage', 'approve'))
      OR (v_membership.role = 'finance'
        AND v_module IN ('expense', 'cam', 'budget')
        AND v_action IN ('view', 'review', 'approve'))
      OR (v_membership.role = 'accounting'
        AND v_module IN ('expense', 'cam', 'budget')
        AND v_action IN ('view', 'review'))
      OR (v_membership.role = 'auditor'
        AND v_module IN ('lease', 'expense', 'cam', 'budget', 'critical_dates')
        AND v_action IN ('view', 'review'));
  END IF;

  IF NOT v_permission_ok THEN
    RETURN FALSE;
  END IF;

  IF NOT v_scope_ok THEN
    IF COALESCE((v_caps #>> ARRAY['scope_access', 'all_portfolios'])::BOOLEAN, FALSE)
       OR COALESCE((v_caps #>> ARRAY['scope_access', 'all_properties'])::BOOLEAN, FALSE) THEN
      v_scope_ok := TRUE;
    ELSIF p_portfolio_id IS NULL AND p_property_id IS NULL THEN
      v_scope_ok := TRUE;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.user_access ua
        WHERE ua.user_id = auth.uid()
          AND ua.org_id = p_org_id
          AND ua.is_active = TRUE
          AND (ua.expires_at IS NULL OR ua.expires_at > now())
          AND (
            (ua.scope = 'portfolio' AND ua.scope_id = p_portfolio_id)
            OR (ua.scope = 'property' AND ua.scope_id = p_property_id)
          )
      )
      INTO v_scope_ok;
    END IF;
  END IF;

  RETURN v_scope_ok;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_approve_notification_event(UUID, TEXT, UUID, UUID) TO authenticated;
