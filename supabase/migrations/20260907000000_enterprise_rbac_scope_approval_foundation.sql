-- Enterprise CRE authorization, approval, delegation, and tenant-email foundation.
--
-- Additive, compatibility-first migration:
-- - memberships remains the source of organization membership.
-- - existing page/module permissions and user_access continue to work.
-- - new tables generalize role + scope + permission + approval authority.
-- - policy resolution is: property override -> portfolio override -> organization -> system default.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS tenant_portal_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS assigned_properties TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS assigned_buildings TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS assigned_units TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS assigned_leases TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS approval_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.role_definitions
  ADD COLUMN IF NOT EXISTS role_type TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS permission_set JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS approval_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_definitions_system_role_key
  ON public.role_definitions(role_key)
  WHERE org_id IS NULL;

CREATE TABLE IF NOT EXISTS public.user_scope_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID REFERENCES public.memberships(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_key TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'portfolio', 'property', 'building', 'unit', 'lease')),
  scope_id UUID,
  access_level TEXT NOT NULL DEFAULT 'read' CHECK (access_level IN ('read', 'write', 'review', 'validate', 'approve', 'admin', 'full')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'organization' AND scope_id IS NULL)
    OR (scope_type <> 'organization' AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_scope_assignments_unique_active
  ON public.user_scope_assignments(user_id, org_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_user_scope_assignments_user_org
  ON public.user_scope_assignments(user_id, org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_scope_assignments_scope
  ON public.user_scope_assignments(org_id, scope_type, scope_id, is_active);

CREATE TABLE IF NOT EXISTS public.approval_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  entity_type TEXT,
  scope_type TEXT NOT NULL DEFAULT 'organization' CHECK (scope_type IN ('system', 'organization', 'portfolio', 'property')),
  scope_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
  require_property_owner_approval BOOLEAN NOT NULL DEFAULT FALSE,
  allow_self_approval BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'system' AND org_id IS NULL AND scope_id IS NULL)
    OR (scope_type = 'organization' AND org_id IS NOT NULL AND scope_id IS NULL)
    OR (scope_type IN ('portfolio', 'property') AND org_id IS NOT NULL AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_policies_active_scope
  ON public.approval_policies(workflow_type, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS public.approval_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES public.approval_policies(id) ON DELETE CASCADE,
  min_amount NUMERIC NOT NULL DEFAULT 0,
  max_amount NUMERIC,
  approval_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_amount IS NULL OR max_amount >= min_amount)
);

CREATE INDEX IF NOT EXISTS idx_approval_thresholds_policy_amount
  ON public.approval_thresholds(policy_id, min_amount, max_amount);

CREATE TABLE IF NOT EXISTS public.approval_workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  policy_id UUID REFERENCES public.approval_policies(id) ON DELETE SET NULL,
  workflow_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'FINANCE_REVIEW', 'PENDING_APPROVAL',
    'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CHANGES',
    'RESUBMITTED', 'SIGNED', 'COMPLETED', 'CANCELLED'
  )),
  current_stage TEXT,
  current_step_id UUID,
  submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_instances_org_status
  ON public.approval_workflow_instances(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_instances_entity
  ON public.approval_workflow_instances(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approval_instances_scope
  ON public.approval_workflow_instances(org_id, portfolio_id, property_id, lease_id);

CREATE TABLE IF NOT EXISTS public.approval_workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id UUID NOT NULL REFERENCES public.approval_workflow_instances(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  stage_key TEXT NOT NULL,
  action_required TEXT NOT NULL CHECK (action_required IN ('review', 'validate', 'approve', 'sign')),
  approver_role TEXT,
  approver_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  minimum_amount NUMERIC,
  maximum_amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CHANGES', 'SKIPPED', 'DELEGATED')),
  assigned_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  comments TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_instance_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_approval_steps_assignee
  ON public.approval_workflow_steps(approver_user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_approval_steps_instance
  ON public.approval_workflow_steps(workflow_instance_id, sequence_number);

CREATE TABLE IF NOT EXISTS public.approval_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id UUID NOT NULL REFERENCES public.approval_workflow_instances(id) ON DELETE CASCADE,
  workflow_step_id UUID REFERENCES public.approval_workflow_steps(id) ON DELETE SET NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role TEXT,
  action TEXT NOT NULL CHECK (action IN ('submit', 'review', 'validate', 'approve', 'reject', 'return_for_changes', 'resubmit', 'sign', 'delegate', 'cancel')),
  comments TEXT,
  rejection_reason TEXT,
  entity_version INTEGER,
  delegated_from_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  delegated_authority_id UUID,
  previous_status TEXT,
  new_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    action NOT IN ('reject', 'return_for_changes')
    OR (
      length(trim(COALESCE(rejection_reason, ''))) > 0
      AND length(trim(COALESCE(comments, ''))) > 0
      AND entity_version IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_actions_instance
  ON public.approval_actions(workflow_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_actions_actor
  ON public.approval_actions(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.approval_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delegator_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delegate_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'portfolio', 'property', 'building', 'unit', 'lease')),
  scope_id UUID,
  maximum_approval_amount NUMERIC,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'expired', 'revoked')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (
    (scope_type = 'organization' AND scope_id IS NULL)
    OR (scope_type <> 'organization' AND scope_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_delegations_delegate
  ON public.approval_delegations(delegate_user_id, org_id, status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.tenant_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  full_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  contact_type TEXT NOT NULL DEFAULT 'primary',
  notification_categories TEXT[] NOT NULL DEFAULT ARRAY[
    'lease_notice', 'rent_schedule', 'upcoming_rent', 'cam_statement',
    'critical_date', 'document', 'notice', 'request'
  ],
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_contacts_tenant
  ON public.tenant_contacts(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_contacts_email
  ON public.tenant_contacts(lower(email));

CREATE TABLE IF NOT EXISTS public.tenant_email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  tenant_contact_id UUID REFERENCES public.tenant_contacts(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'lease_notice', 'rent_schedule', 'upcoming_rent', 'cam_statement',
    'critical_date', 'document', 'notice', 'request'
  )),
  subject TEXT NOT NULL,
  body_template_key TEXT,
  destination_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_email_events_scope
  ON public.tenant_email_events(org_id, tenant_id, lease_id, property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_email_events_status
  ON public.tenant_email_events(status, created_at);

CREATE TABLE IF NOT EXISTS public.critical_date_notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  critical_date_type TEXT NOT NULL,
  reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[180, 120, 90, 60, 30],
  recipient_roles TEXT[] NOT NULL DEFAULT ARRAY['property_manager'],
  escalation_roles TEXT[] NOT NULL DEFAULT ARRAY['portfolio_manager', 'org_admin', 'org_owner'],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, property_id, critical_date_type)
);

ALTER TABLE public.user_scope_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critical_date_notification_rules ENABLE ROW LEVEL SECURITY;

INSERT INTO public.role_definitions (
  org_id, role_key, label, description, role_type, permission_set, default_capabilities,
  approval_limits, notification_preferences, is_system, is_active
)
VALUES
  (NULL, 'org_owner', 'Organization Owner', 'Highest internal business authority with configurable final approval ownership.', 'standard',
   '{"lease":["view","review","approve","reject","sign","comment"],"expense":["view","review","approve","reject","export","comment"],"budget":["view","review","approve","reject","export","comment"],"cam":["view","review","approve","export","comment"],"revenue":["view","export","adjust"],"critical_dates":["view","comment"],"rent_schedule":["view","review","export"],"reports":["view","export"],"audit":["view","export"],"user":["view","create","edit","assign"],"role":["view","create","edit","assign"],"workflow":["configure"],"approval_policy":["configure"],"delegation":["create","edit","view"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"review":true,"approve":true,"reject":true,"sign":true,"comment":true},"expense":{"view":true,"review":true,"approve":true,"reject":true,"export":true,"comment":true},"budget":{"view":true,"review":true,"approve":true,"reject":true,"export":true,"comment":true},"cam":{"view":true,"review":true,"approve":true,"export":true,"comment":true},"revenue":{"view":true,"export":true,"adjust":true},"critical_dates":{"view":true,"comment":true},"rent_schedule":{"view":true,"review":true,"export":true},"reports":{"view":true,"export":true},"audit":{"view":true,"export":true},"user":{"view":true,"create":true,"edit":true,"assign":true},"role":{"view":true,"create":true,"edit":true,"assign":true},"workflow":{"configure":true},"approval_policy":{"configure":true},"delegation":{"create":true,"edit":true,"view":true}},"approval_limits":{"expense":null,"budget":null,"cam":null,"lease":null},"scope_access":{"all_portfolios":true,"all_properties":true}}'::jsonb,
   '{"expense":null,"budget":null,"cam":null,"lease":null}'::jsonb, '{"major_approvals":true}'::jsonb, TRUE, TRUE),
  (NULL, 'org_admin', 'Organization Admin', 'Operational/system authority without default final business approval authority.', 'standard',
   '{"lease":["view","review","comment"],"expense":["view","review","comment"],"budget":["view","review","comment"],"cam":["view","review","comment"],"revenue":["view","export"],"critical_dates":["view","comment"],"rent_schedule":["view","review"],"reports":["view","export"],"audit":["view"],"user":["view","create","edit","assign"],"role":["view","create","edit","assign"],"workflow":["configure"],"approval_policy":["configure"],"delegation":["view"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"review":true,"comment":true},"expense":{"view":true,"review":true,"comment":true},"budget":{"view":true,"review":true,"comment":true},"cam":{"view":true,"review":true,"comment":true},"revenue":{"view":true,"export":true},"critical_dates":{"view":true,"comment":true},"rent_schedule":{"view":true,"review":true},"reports":{"view":true,"export":true},"audit":{"view":true},"user":{"view":true,"create":true,"edit":true,"assign":true},"role":{"view":true,"create":true,"edit":true,"assign":true},"workflow":{"configure":true},"approval_policy":{"configure":true},"delegation":{"view":true}},"scope_access":{"all_portfolios":true,"all_properties":true}}'::jsonb,
   '{}'::jsonb, '{"escalations":true}'::jsonb, TRUE, TRUE),
  (NULL, 'portfolio_manager', 'Portfolio Manager', 'Scoped portfolio operator and selected approval layer.', 'standard',
   '{"lease":["view","review","comment"],"expense":["view","review","approve","reject","comment"],"budget":["view","review","approve","reject","comment"],"cam":["view","review","approve","comment"],"revenue":["view","export"],"critical_dates":["view","comment"],"rent_schedule":["view","review"],"reports":["view","export"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"review":true,"comment":true},"expense":{"view":true,"review":true,"approve":true,"reject":true,"comment":true},"budget":{"view":true,"review":true,"approve":true,"reject":true,"comment":true},"cam":{"view":true,"review":true,"approve":true,"comment":true},"revenue":{"view":true,"export":true},"critical_dates":{"view":true,"comment":true},"rent_schedule":{"view":true,"review":true},"reports":{"view":true,"export":true}},"approval_limits":{"expense":25000,"budget":250000,"cam":250000}}'::jsonb,
   '{"expense":25000,"budget":250000,"cam":250000}'::jsonb, '{"approval_requests":true,"escalations":true}'::jsonb, TRUE, TRUE),
  (NULL, 'property_manager', 'Property Manager', 'Scoped property operator with limited configured approval authority.', 'standard',
   '{"lease":["view","review","comment"],"expense":["view","create","edit","submit","review","approve","reject","comment"],"budget":["view","create","edit","submit","review","approve","reject","comment"],"cam":["view","review","comment"],"revenue":["view"],"critical_dates":["view","edit","comment"],"rent_schedule":["view","review"],"reports":["view"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"review":true,"comment":true},"expense":{"view":true,"create":true,"edit":true,"submit":true,"review":true,"approve":true,"reject":true,"comment":true},"budget":{"view":true,"create":true,"edit":true,"submit":true,"review":true,"approve":true,"reject":true,"comment":true},"cam":{"view":true,"review":true,"comment":true},"revenue":{"view":true},"critical_dates":{"view":true,"edit":true,"comment":true},"rent_schedule":{"view":true,"review":true},"reports":{"view":true}},"approval_limits":{"expense":5000,"budget":50000}}'::jsonb,
   '{"expense":5000,"budget":50000}'::jsonb, '{"operational":true,"approval_requests":true}'::jsonb, TRUE, TRUE),
  (NULL, 'lease_admin', 'Lease Admin / Leasing Agent', 'Scoped lease creator and submitter without self-approval authority.', 'standard',
   '{"lease":["view","create","edit","upload","submit","comment"],"critical_dates":["view","create","edit"],"rent_schedule":["view","create","edit","submit"],"documents":["view","upload"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"create":true,"edit":true,"upload":true,"submit":true,"comment":true},"critical_dates":{"view":true,"create":true,"edit":true},"rent_schedule":{"view":true,"create":true,"edit":true,"submit":true},"documents":{"view":true,"upload":true}}}'::jsonb,
   '{}'::jsonb, '{"lease_rejections":true}'::jsonb, TRUE, TRUE),
  (NULL, 'finance', 'Finance Team', 'Financial review and validation function, not default final business approver.', 'standard',
   '{"expense":["view","review","validate","reject","comment","export"],"budget":["view","review","validate","reject","comment","export"],"cam":["view","create","edit","review","validate","comment","export"],"revenue":["view","export","reconcile","adjust"],"rent_schedule":["view","review","validate"],"reports":["view","export"]}'::jsonb,
   '{"permissions":{"expense":{"view":true,"review":true,"validate":true,"reject":true,"comment":true,"export":true},"budget":{"view":true,"review":true,"validate":true,"reject":true,"comment":true,"export":true},"cam":{"view":true,"create":true,"edit":true,"review":true,"validate":true,"comment":true,"export":true},"revenue":{"view":true,"export":true,"reconcile":true,"adjust":true},"rent_schedule":{"view":true,"review":true,"validate":true},"reports":{"view":true,"export":true}}}'::jsonb,
   '{}'::jsonb, '{"finance_review":true}'::jsonb, TRUE, TRUE),
  (NULL, 'property_owner', 'Property Owner', 'External business owner scoped only to owned properties.', 'standard',
   '{"lease":["view","approve","reject","comment"],"expense":["view","approve","reject","comment"],"budget":["view","approve","reject","comment"],"cam":["view","approve","comment"],"revenue":["view","export"],"critical_dates":["view"],"rent_schedule":["view"],"reports":["view","export"],"documents":["view"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"approve":true,"reject":true,"comment":true},"expense":{"view":true,"approve":true,"reject":true,"comment":true},"budget":{"view":true,"approve":true,"reject":true,"comment":true},"cam":{"view":true,"approve":true,"comment":true},"revenue":{"view":true,"export":true},"critical_dates":{"view":true},"rent_schedule":{"view":true},"reports":{"view":true,"export":true},"documents":{"view":true}},"approval_limits":{"expense":null,"budget":null,"cam":null,"lease":null}}'::jsonb,
   '{"expense":null,"budget":null,"cam":null,"lease":null}'::jsonb, '{"major_approvals":true}'::jsonb, TRUE, TRUE),
  (NULL, 'auditor', 'Auditor', 'Scoped read-only audit and supporting-document access.', 'standard',
   '{"lease":["view","export"],"expense":["view","export"],"budget":["view","export"],"cam":["view","export"],"revenue":["view","export"],"critical_dates":["view"],"rent_schedule":["view","export"],"reports":["view","export"],"audit":["view","export"],"documents":["view"]}'::jsonb,
   '{"permissions":{"lease":{"view":true,"export":true},"expense":{"view":true,"export":true},"budget":{"view":true,"export":true},"cam":{"view":true,"export":true},"revenue":{"view":true,"export":true},"critical_dates":{"view":true},"rent_schedule":{"view":true,"export":true},"reports":{"view":true,"export":true},"audit":{"view":true,"export":true},"documents":{"view":true}}}'::jsonb,
   '{}'::jsonb, '{"audit":true}'::jsonb, TRUE, TRUE),
  (NULL, 'tenant', 'Tenant', 'Future external-access role. Tenant portal is disabled by default in V1.', 'standard',
   '{}'::jsonb, '{"permissions":{}}'::jsonb, '{}'::jsonb, '{"tenant_email":true}'::jsonb, TRUE, TRUE),
  (NULL, 'custom_role', 'Custom Role', 'Organization-defined role resolved through the same permission engine.', 'custom',
   '{}'::jsonb, '{"permissions":{}}'::jsonb, '{}'::jsonb, '{}'::jsonb, TRUE, TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO public.approval_policies (org_id, workflow_type, entity_type, scope_type, scope_id, name, description, thresholds, is_active)
VALUES
  (NULL, 'expense', 'expense', 'system', NULL, 'System Default Expense Approval Policy',
   'Default starter thresholds; override by organization, portfolio, or property.',
   '[
      {"min_amount":0,"max_amount":5000,"steps":[{"role":"property_manager","action":"approve"}]},
      {"min_amount":5000.01,"max_amount":25000,"steps":[{"role":"property_manager","action":"review"},{"role":"portfolio_manager","action":"approve"}]},
      {"min_amount":25000.01,"max_amount":100000,"steps":[{"role":"property_manager","action":"review"},{"role":"portfolio_manager","action":"review"},{"role":"finance","action":"validate"},{"role":"org_owner","action":"approve"}]},
      {"min_amount":100000.01,"max_amount":null,"steps":[{"role":"property_manager","action":"review"},{"role":"portfolio_manager","action":"review"},{"role":"finance","action":"validate"},{"role":"org_owner","action":"approve"},{"role":"property_owner","action":"approve"}]}
    ]'::jsonb, TRUE),
  (NULL, 'budget', 'budget', 'system', NULL, 'System Default Budget Approval Policy',
   'Budget workflow default.',
   '[{"min_amount":0,"max_amount":null,"steps":[{"role":"portfolio_manager","action":"review"},{"role":"finance","action":"validate"},{"role":"org_owner","action":"approve"}]}]'::jsonb, TRUE),
  (NULL, 'cam', 'cam', 'system', NULL, 'System Default CAM Approval Policy',
   'CAM workflow default.',
   '[{"min_amount":0,"max_amount":null,"steps":[{"role":"finance","action":"validate"},{"role":"property_manager","action":"review"},{"role":"org_owner","action":"approve"}]}]'::jsonb, TRUE),
  (NULL, 'lease', 'lease', 'system', NULL, 'System Default Lease Approval Policy',
   'Lease workflow default.',
   '[{"min_amount":0,"max_amount":null,"steps":[{"role":"property_manager","action":"review"},{"role":"org_owner","action":"approve"},{"role":"authorized_signatory","action":"sign"}]}]'::jsonb, TRUE)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.cre_normalize_role(p_role TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_role, ''))
    WHEN 'owner' THEN 'org_owner'
    WHEN 'admin' THEN 'org_admin'
    WHEN 'manager' THEN 'property_manager'
    WHEN 'editor' THEN 'lease_admin'
    WHEN 'viewer' THEN 'auditor'
    WHEN 'read_only' THEN 'auditor'
    WHEN 'asset_manager' THEN 'portfolio_manager'
    ELSE lower(COALESCE(p_role, 'auditor'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.cre_role_permission_allows(p_role TEXT, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      WITH parts AS (
        SELECT split_part(p_permission, '.', 1) AS module_key,
               split_part(p_permission, '.', 2) AS action_key
      )
      SELECT COALESCE((rd.default_capabilities #>> ARRAY['permissions', parts.module_key, parts.action_key])::BOOLEAN, FALSE)
      FROM public.role_definitions rd
      CROSS JOIN parts
      WHERE rd.org_id IS NULL
        AND rd.role_key = public.cre_normalize_role(p_role)
        AND rd.is_active = TRUE
      LIMIT 1
    ),
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public.cre_user_has_scope(
  p_org_id UUID,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership public.memberships%ROWTYPE;
  v_role TEXT;
  v_scope_access JSONB;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF public.is_super_admin() THEN
    RETURN TRUE;
  END IF;

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

  v_role := public.cre_normalize_role(v_membership.role);
  v_scope_access := COALESCE(v_membership.capabilities->'scope_access', '{}'::jsonb);

  IF p_scope_type IS NULL OR p_scope_type = 'organization' THEN
    RETURN TRUE;
  END IF;

  IF v_role IN ('org_owner', 'org_admin')
     OR COALESCE((v_scope_access->>'all_portfolios')::BOOLEAN, FALSE)
     OR COALESCE((v_scope_access->>'all_properties')::BOOLEAN, FALSE) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_scope_assignments usa
    WHERE usa.user_id = auth.uid()
      AND usa.org_id = p_org_id
      AND usa.is_active = TRUE
      AND (usa.starts_at IS NULL OR usa.starts_at <= now())
      AND (usa.expires_at IS NULL OR usa.expires_at > now())
      AND (
        (usa.scope_type = p_scope_type AND usa.scope_id = p_scope_id)
        OR (usa.scope_type = 'organization' AND usa.scope_id IS NULL)
        OR (p_scope_type = 'property' AND usa.scope_type = 'portfolio' AND usa.scope_id = (SELECT portfolio_id FROM public.properties WHERE id = p_scope_id))
        OR (p_scope_type = 'building' AND usa.scope_type = 'property' AND usa.scope_id = (SELECT property_id FROM public.buildings WHERE id = p_scope_id))
        OR (p_scope_type = 'unit' AND usa.scope_type = 'building' AND usa.scope_id = (SELECT building_id FROM public.units WHERE id = p_scope_id))
        OR (p_scope_type = 'unit' AND usa.scope_type = 'property' AND usa.scope_id = (SELECT property_id FROM public.units WHERE id = p_scope_id))
        OR (p_scope_type = 'lease' AND usa.scope_type = 'unit' AND usa.scope_id = (SELECT unit_id FROM public.leases WHERE id = p_scope_id))
        OR (p_scope_type = 'lease' AND usa.scope_type = 'property' AND usa.scope_id = (SELECT property_id FROM public.leases WHERE id = p_scope_id))
        OR (p_scope_type IN ('building', 'unit', 'lease') AND usa.scope_type = 'portfolio' AND usa.scope_id = (
          SELECT pr.portfolio_id
          FROM public.properties pr
          WHERE pr.id = COALESCE(
            (SELECT property_id FROM public.buildings WHERE id = p_scope_id AND p_scope_type = 'building'),
            (SELECT property_id FROM public.units WHERE id = p_scope_id AND p_scope_type = 'unit'),
            (SELECT property_id FROM public.leases WHERE id = p_scope_id AND p_scope_type = 'lease')
          )
        ))
      )
  ) THEN
    RETURN TRUE;
  END IF;

  IF p_scope_type IN ('portfolio', 'property') THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.user_access ua
      WHERE ua.user_id = auth.uid()
        AND ua.org_id = p_org_id
        AND ua.is_active = TRUE
        AND (ua.expires_at IS NULL OR ua.expires_at > now())
        AND (
          (p_scope_type = 'portfolio' AND ua.scope = 'portfolio' AND ua.scope_id = p_scope_id)
          OR (p_scope_type = 'property' AND ua.scope = 'property' AND ua.scope_id = p_scope_id)
          OR (p_scope_type = 'property' AND ua.scope = 'portfolio' AND ua.scope_id = (SELECT portfolio_id FROM public.properties WHERE id = p_scope_id))
        )
    );
  END IF;

  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.cre_has_permission(
  p_org_id UUID,
  p_permission TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership public.memberships%ROWTYPE;
  v_module TEXT;
  v_action TEXT;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_permission IS NULL THEN
    RETURN FALSE;
  END IF;

  IF public.is_super_admin() THEN
    RETURN TRUE;
  END IF;

  IF NOT public.cre_user_has_scope(p_org_id, p_scope_type, p_scope_id) THEN
    RETURN FALSE;
  END IF;

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

  v_module := split_part(p_permission, '.', 1);
  v_action := split_part(p_permission, '.', 2);

  RETURN
    COALESCE((v_membership.capabilities #>> ARRAY['permissions', v_module, v_action])::BOOLEAN, FALSE)
    OR COALESCE((v_membership.capabilities #>> ARRAY['custom_permissions', v_module, v_action])::BOOLEAN, FALSE)
    OR public.cre_role_permission_allows(v_membership.role, p_permission);
END;
$$;

CREATE OR REPLACE FUNCTION public.cre_approval_limit(
  p_org_id UUID,
  p_workflow_type TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership public.memberships%ROWTYPE;
  v_limit_text TEXT;
  v_role_limit_text TEXT;
  v_membership_unlimited BOOLEAN := FALSE;
  v_role_unlimited BOOLEAN := FALSE;
  v_delegate_limit NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_workflow_type IS NULL THEN
    RETURN 0;
  END IF;

  IF public.is_super_admin() THEN
    RETURN 999999999999;
  END IF;

  SELECT *
  INTO v_membership
  FROM public.memberships
  WHERE user_id = auth.uid()
    AND org_id = p_org_id
    AND COALESCE(status, 'active') IN ('active', 'owner', 'approved')
  LIMIT 1;

  IF v_membership.user_id IS NULL THEN
    RETURN 0;
  END IF;

  v_membership_unlimited :=
    (COALESCE(v_membership.approval_limits, '{}'::jsonb) ? p_workflow_type
      AND jsonb_typeof(v_membership.approval_limits->p_workflow_type) = 'null')
    OR (COALESCE(v_membership.capabilities->'approval_limits', '{}'::jsonb) ? p_workflow_type
      AND jsonb_typeof(v_membership.capabilities->'approval_limits'->p_workflow_type) = 'null');

  IF NOT v_membership_unlimited THEN
    v_limit_text := COALESCE(
      v_membership.approval_limits->>p_workflow_type,
      v_membership.capabilities #>> ARRAY['approval_limits', p_workflow_type]
    );
  END IF;

  SELECT
    rd.approval_limits->>p_workflow_type,
    (COALESCE(rd.approval_limits, '{}'::jsonb) ? p_workflow_type
      AND jsonb_typeof(rd.approval_limits->p_workflow_type) = 'null')
  INTO v_role_limit_text, v_role_unlimited
  FROM public.role_definitions rd
  WHERE rd.org_id IS NULL
    AND rd.role_key = public.cre_normalize_role(v_membership.role)
  LIMIT 1;

  SELECT max(COALESCE(maximum_approval_amount, 999999999999))
  INTO v_delegate_limit
  FROM public.approval_delegations d
  WHERE d.delegate_user_id = auth.uid()
    AND d.org_id = p_org_id
    AND d.permission = p_workflow_type || '.approve'
    AND d.status = 'active'
    AND d.starts_at <= now()
    AND d.ends_at > now()
    AND (
      d.scope_type = 'organization'
      OR (d.scope_type = p_scope_type AND d.scope_id = p_scope_id)
    );

  IF v_membership_unlimited OR COALESCE(v_role_unlimited, FALSE) THEN
    RETURN GREATEST(COALESCE(v_delegate_limit, 0), 999999999999);
  END IF;

  RETURN GREATEST(
    COALESCE(NULLIF(v_limit_text, '')::NUMERIC, 0),
    COALESCE(NULLIF(v_role_limit_text, '')::NUMERIC, 0),
    COALESCE(v_delegate_limit, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cre_can_approve(
  p_org_id UUID,
  p_workflow_type TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_amount NUMERIC DEFAULT 0,
  p_submitter_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.cre_has_permission(p_org_id, p_workflow_type || '.approve', p_scope_type, p_scope_id)
     AND (p_submitter_user_id IS NULL OR p_submitter_user_id IS DISTINCT FROM auth.uid())
     AND public.cre_approval_limit(p_org_id, p_workflow_type, p_scope_type, p_scope_id) >= COALESCE(p_amount, 0);
$$;

GRANT EXECUTE ON FUNCTION public.cre_user_has_scope(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cre_has_permission(UUID, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cre_approval_limit(UUID, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cre_can_approve(UUID, TEXT, TEXT, UUID, NUMERIC, UUID) TO authenticated;

DROP POLICY IF EXISTS "user_scope_assignments_select" ON public.user_scope_assignments;
DROP POLICY IF EXISTS "user_scope_assignments_write" ON public.user_scope_assignments;
CREATE POLICY "user_scope_assignments_select" ON public.user_scope_assignments
  FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "user_scope_assignments_write" ON public.user_scope_assignments
  FOR ALL USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS "approval_policies_select" ON public.approval_policies;
DROP POLICY IF EXISTS "approval_policies_write" ON public.approval_policies;
CREATE POLICY "approval_policies_select" ON public.approval_policies
  FOR SELECT USING (scope_type = 'system' OR public.is_active_org_member(org_id));
CREATE POLICY "approval_policies_write" ON public.approval_policies
  FOR ALL USING (org_id IS NOT NULL AND public.cre_has_permission(org_id, 'approval_policy.configure'))
  WITH CHECK (org_id IS NOT NULL AND public.cre_has_permission(org_id, 'approval_policy.configure'));

DROP POLICY IF EXISTS "approval_thresholds_select" ON public.approval_thresholds;
DROP POLICY IF EXISTS "approval_thresholds_write" ON public.approval_thresholds;
CREATE POLICY "approval_thresholds_select" ON public.approval_thresholds
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = approval_thresholds.policy_id
        AND (p.scope_type = 'system' OR public.is_active_org_member(p.org_id))
    )
  );
CREATE POLICY "approval_thresholds_write" ON public.approval_thresholds
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = approval_thresholds.policy_id
        AND p.org_id IS NOT NULL
        AND public.cre_has_permission(p.org_id, 'approval_policy.configure')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.approval_policies p
      WHERE p.id = approval_thresholds.policy_id
        AND p.org_id IS NOT NULL
        AND public.cre_has_permission(p.org_id, 'approval_policy.configure')
    )
  );

DROP POLICY IF EXISTS "approval_instances_select" ON public.approval_workflow_instances;
DROP POLICY IF EXISTS "approval_instances_insert" ON public.approval_workflow_instances;
DROP POLICY IF EXISTS "approval_instances_update" ON public.approval_workflow_instances;
CREATE POLICY "approval_instances_select" ON public.approval_workflow_instances
  FOR SELECT USING (
    public.cre_has_permission(org_id, workflow_type || '.view', 'property', property_id)
    OR public.cre_has_permission(org_id, workflow_type || '.review', 'property', property_id)
    OR public.cre_has_permission(org_id, workflow_type || '.approve', 'property', property_id)
  );
CREATE POLICY "approval_instances_insert" ON public.approval_workflow_instances
  FOR INSERT WITH CHECK (public.cre_has_permission(org_id, workflow_type || '.submit', 'property', property_id));
CREATE POLICY "approval_instances_update" ON public.approval_workflow_instances
  FOR UPDATE USING (
    public.cre_has_permission(org_id, workflow_type || '.review', 'property', property_id)
    OR public.cre_has_permission(org_id, workflow_type || '.validate', 'property', property_id)
    OR public.cre_can_approve(org_id, workflow_type, 'property', property_id, amount, submitted_by)
  );

DROP POLICY IF EXISTS "approval_steps_select" ON public.approval_workflow_steps;
DROP POLICY IF EXISTS "approval_steps_write" ON public.approval_workflow_steps;
CREATE POLICY "approval_steps_select" ON public.approval_workflow_steps
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.approval_workflow_instances i
      WHERE i.id = approval_workflow_steps.workflow_instance_id
        AND public.is_active_org_member(i.org_id)
    )
  );
CREATE POLICY "approval_steps_write" ON public.approval_workflow_steps
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.approval_workflow_instances i
      WHERE i.id = approval_workflow_steps.workflow_instance_id
        AND public.cre_has_permission(i.org_id, i.workflow_type || '.review', 'property', i.property_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.approval_workflow_instances i
      WHERE i.id = approval_workflow_steps.workflow_instance_id
        AND public.cre_has_permission(i.org_id, i.workflow_type || '.review', 'property', i.property_id)
    )
  );

DROP POLICY IF EXISTS "approval_actions_select" ON public.approval_actions;
DROP POLICY IF EXISTS "approval_actions_insert" ON public.approval_actions;
CREATE POLICY "approval_actions_select" ON public.approval_actions
  FOR SELECT USING (public.is_active_org_member(org_id));
CREATE POLICY "approval_actions_insert" ON public.approval_actions
  FOR INSERT WITH CHECK (public.is_active_org_member(org_id));

DROP POLICY IF EXISTS "approval_delegations_select" ON public.approval_delegations;
DROP POLICY IF EXISTS "approval_delegations_write" ON public.approval_delegations;
CREATE POLICY "approval_delegations_select" ON public.approval_delegations
  FOR SELECT USING (
    delegator_user_id = auth.uid()
    OR delegate_user_id = auth.uid()
    OR public.cre_has_permission(org_id, 'delegation.view')
  );
CREATE POLICY "approval_delegations_write" ON public.approval_delegations
  FOR ALL USING (
    delegator_user_id = auth.uid()
    OR public.cre_has_permission(org_id, 'delegation.create')
  )
  WITH CHECK (
    delegator_user_id = auth.uid()
    OR public.cre_has_permission(org_id, 'delegation.create')
  );

DROP POLICY IF EXISTS "tenant_contacts_select" ON public.tenant_contacts;
DROP POLICY IF EXISTS "tenant_contacts_write" ON public.tenant_contacts;
CREATE POLICY "tenant_contacts_select" ON public.tenant_contacts
  FOR SELECT USING (public.cre_has_permission(org_id, 'lease.view', 'property', property_id));
CREATE POLICY "tenant_contacts_write" ON public.tenant_contacts
  FOR ALL USING (public.cre_has_permission(org_id, 'lease.edit', 'property', property_id))
  WITH CHECK (public.cre_has_permission(org_id, 'lease.edit', 'property', property_id));

DROP POLICY IF EXISTS "tenant_email_events_select" ON public.tenant_email_events;
DROP POLICY IF EXISTS "tenant_email_events_write" ON public.tenant_email_events;
CREATE POLICY "tenant_email_events_select" ON public.tenant_email_events
  FOR SELECT USING (public.cre_has_permission(org_id, 'lease.view', 'property', property_id));
CREATE POLICY "tenant_email_events_write" ON public.tenant_email_events
  FOR ALL USING (public.cre_has_permission(org_id, 'lease.submit', 'property', property_id) OR public.cre_has_permission(org_id, 'cam.validate', 'property', property_id))
  WITH CHECK (public.cre_has_permission(org_id, 'lease.submit', 'property', property_id) OR public.cre_has_permission(org_id, 'cam.validate', 'property', property_id));

DROP POLICY IF EXISTS "critical_date_notification_rules_select" ON public.critical_date_notification_rules;
DROP POLICY IF EXISTS "critical_date_notification_rules_write" ON public.critical_date_notification_rules;
CREATE POLICY "critical_date_notification_rules_select" ON public.critical_date_notification_rules
  FOR SELECT USING (public.cre_has_permission(org_id, 'critical_dates.view', 'property', property_id));
CREATE POLICY "critical_date_notification_rules_write" ON public.critical_date_notification_rules
  FOR ALL USING (public.cre_has_permission(org_id, 'approval_policy.configure'))
  WITH CHECK (public.cre_has_permission(org_id, 'approval_policy.configure'));
