-- Migration: 20260514130000_lease_critical_dates.sql
-- Description: Adds a per-lease critical-dates audit table so reviewers can
--              track lease milestones (commencement, expiration, renewal
--              notice, option deadlines, insurance certificate due dates,
--              termination notice deadlines, etc.), assign owners, and mark
--              them complete. Additive only.

CREATE TABLE IF NOT EXISTS public.lease_critical_dates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id             UUID NOT NULL REFERENCES public.leases(id)        ON DELETE CASCADE,
  property_id          UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  date_type            TEXT NOT NULL,        -- lease_date | commencement | rent_commencement | expiration | renewal_notice | option_exercise | insurance_certificate | termination_notice | custom
  due_date             DATE NOT NULL,
  owner_email          TEXT,
  owner_name           TEXT,
  status               TEXT NOT NULL DEFAULT 'open',  -- open | completed | dismissed
  completed_at         TIMESTAMPTZ,
  completed_by         TEXT,
  reminder_days_before INT,
  note                 TEXT,
  source               TEXT NOT NULL DEFAULT 'manual',  -- manual | derived | imported
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id, date_type, due_date)
);

COMMENT ON TABLE public.lease_critical_dates IS
  'Tracked critical dates per lease (renewal notice, option exercise, expiration, etc.) with owners and completion status.';

CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_lease
  ON public.lease_critical_dates (org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_due
  ON public.lease_critical_dates (org_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_owner
  ON public.lease_critical_dates (owner_email)
  WHERE owner_email IS NOT NULL;

ALTER TABLE public.lease_critical_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_critical_dates_select" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_insert" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_update" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_delete" ON public.lease_critical_dates;

CREATE POLICY "lease_critical_dates_select" ON public.lease_critical_dates
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "lease_critical_dates_insert" ON public.lease_critical_dates
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_critical_dates_update" ON public.lease_critical_dates
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_critical_dates_delete" ON public.lease_critical_dates
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_critical_dates_updated_at ON public.lease_critical_dates;
CREATE TRIGGER set_lease_critical_dates_updated_at
  BEFORE UPDATE ON public.lease_critical_dates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- Backfill: seed derived rows for existing leases so the dashboard is not
-- empty for orgs that approved leases before this migration. Each insert is
-- conditional on the source column being present and the unique constraint
-- prevents duplicates.
INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status)
SELECT l.org_id, l.id, l.property_id, 'commencement', l.start_date, 'derived', 'open'
FROM public.leases l
WHERE l.start_date IS NOT NULL
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;

INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status)
SELECT l.org_id, l.id, l.property_id, 'expiration', l.end_date, 'derived',
       CASE WHEN l.end_date < CURRENT_DATE THEN 'completed' ELSE 'open' END
FROM public.leases l
WHERE l.end_date IS NOT NULL
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;

-- Renewal notice deadline = expiration - renewal_notice_days. Existing
-- column on leases is renewal_notice_days (added in
-- 20260513133000_lease_workflow_abstraction.sql). Only insert when both
-- pieces are present.
INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status, reminder_days_before)
SELECT
  l.org_id,
  l.id,
  l.property_id,
  'renewal_notice',
  (l.end_date - (COALESCE(l.renewal_notice_days, 0) || ' days')::interval)::date,
  'derived',
  'open',
  30
FROM public.leases l
WHERE l.end_date IS NOT NULL
  AND l.renewal_notice_days IS NOT NULL
  AND l.renewal_notice_days > 0
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;
