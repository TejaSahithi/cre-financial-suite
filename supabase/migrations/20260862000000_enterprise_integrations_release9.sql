-- Release 9: Enterprise integrations, workflow automation, and operational orchestration.

CREATE TABLE IF NOT EXISTS public.integration_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  generation_id TEXT NULL,
  contract_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_id)
);
CREATE INDEX IF NOT EXISTS integration_events_org_event_idx ON public.integration_events (organization_id, event_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_aggregate_idx ON public.integration_events (organization_id, aggregate_type, aggregate_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.integration_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connector_key TEXT NOT NULL,
  endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('webhook', 'erp', 'cmms', 'crm', 'document_management', 'calendar', 'public_api')),
  target_url TEXT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled', 'paused', 'error')),
  supported_events TEXT[] NOT NULL DEFAULT '{}',
  retry_policy JSONB NOT NULL DEFAULT '{"maxAttempts":5,"baseDelaySeconds":30}'::jsonb,
  health JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, connector_key)
);

CREATE TABLE IF NOT EXISTS public.integration_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES public.integration_endpoints(id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('api_key', 'oauth', 'hmac_secret', 'service_account', 'none')),
  credential_ciphertext TEXT NULL,
  secret_fingerprint TEXT NULL,
  rotation_due_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotating', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.integration_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES public.integration_endpoints(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, endpoint_id, event_key, contract_version)
);
CREATE INDEX IF NOT EXISTS integration_subscriptions_event_idx ON public.integration_subscriptions (organization_id, event_key, is_active);

CREATE TABLE IF NOT EXISTS public.integration_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.integration_events(id) ON DELETE CASCADE,
  subscription_id UUID NULL REFERENCES public.integration_subscriptions(id) ON DELETE SET NULL,
  endpoint_id UUID NULL REFERENCES public.integration_endpoints(id) ON DELETE SET NULL,
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued', 'delivering', 'delivered', 'retry_scheduled', 'failed', 'dead_lettered', 'cancelled')),
  next_attempt_at TIMESTAMPTZ NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  latency_ms INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_deliveries_queue_idx ON public.integration_deliveries (organization_id, delivery_status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS public.integration_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL REFERENCES public.integration_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  response_status INTEGER NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  retryable BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.integration_dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delivery_id UUID NULL REFERENCES public.integration_deliveries(id) ON DELETE SET NULL,
  event_id UUID NULL REFERENCES public.integration_events(id) ON DELETE SET NULL,
  endpoint_id UUID NULL REFERENCES public.integration_endpoints(id) ON DELETE SET NULL,
  failed_payload JSONB NOT NULL,
  failure_reason TEXT NOT NULL,
  retry_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_error TEXT NULL,
  recovery_action TEXT NULL,
  replay_status TEXT NOT NULL DEFAULT 'not_replayed' CHECK (replay_status IN ('not_replayed', 'queued', 'replayed', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS integration_dead_letters_org_idx ON public.integration_dead_letters (organization_id, replay_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_key TEXT NOT NULL,
  trigger_event_id UUID NULL REFERENCES public.integration_events(id) ON DELETE SET NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  workflow_status TEXT NOT NULL DEFAULT 'pending' CHECK (workflow_status IN ('pending', 'active', 'waiting', 'blocked', 'completed', 'cancelled', 'failed')),
  current_step_key TEXT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS workflow_instances_scope_idx ON public.workflow_instances (organization_id, workflow_key, workflow_status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_instance_id UUID NOT NULL REFERENCES public.workflow_instances(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  task_label TEXT NOT NULL,
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('user', 'role', 'team', 'queue')),
  assignee_id UUID NULL,
  assignee_key TEXT NULL,
  task_state TEXT NOT NULL DEFAULT 'pending' CHECK (task_state IN ('pending', 'assigned', 'in_progress', 'waiting', 'blocked', 'completed', 'cancelled')),
  due_at TIMESTAMPTZ NULL,
  escalation_at TIMESTAMPTZ NULL,
  completed_by UUID NULL,
  completed_at TIMESTAMPTZ NULL,
  task_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_tasks_queue_idx ON public.workflow_tasks (organization_id, task_state, assignment_type, assignee_key, due_at);

CREATE TABLE IF NOT EXISTS public.notification_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_id UUID NULL REFERENCES public.integration_events(id) ON DELETE SET NULL,
  workflow_task_id UUID NULL REFERENCES public.workflow_tasks(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'in_app', 'webhook', 'slack', 'teams')),
  template_key TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user', 'role', 'team', 'queue', 'endpoint')),
  recipient_key TEXT NOT NULL,
  notification_payload JSONB NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'queued' CHECK (notification_status IN ('queued', 'sent', 'failed', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_queue_status_idx ON public.notification_queue (organization_id, notification_status, scheduled_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'integration_events',
    'integration_endpoints',
    'integration_credentials',
    'integration_subscriptions',
    'integration_deliveries',
    'integration_delivery_attempts',
    'integration_dead_letters',
    'workflow_instances',
    'workflow_tasks',
    'notification_queue'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (organization_id IN (SELECT unnest(public.get_my_org_ids())))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (organization_id IN (SELECT unnest(public.get_my_org_ids())))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (organization_id IN (SELECT unnest(public.get_my_org_ids())))', table_name, table_name);
  END LOOP;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Static policy inventory for Release 9 checks:
-- integration_events_select, integration_subscriptions_select, integration_deliveries_select,
-- integration_delivery_attempts_select, integration_dead_letters_select, integration_endpoints_select,
-- integration_credentials_select, workflow_instances_select, workflow_tasks_select, notification_queue_select.
