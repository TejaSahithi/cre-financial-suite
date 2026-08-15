-- Repair rent_schedules RLS visibility on remote/prod.
--
-- Symptom: compute-lease can generate and return approved rent_schedules rows
-- through the service-role path, but the browser/client query returns zero
-- rows for the same approved lease. The original SELECT policy used:
--   org_id IN (SELECT public.get_my_org_ids())
-- which is safe on local where get_my_org_ids() returns SETOF uuid, but has
-- drifted on remote environments where get_my_org_ids() returns uuid[]. Other
-- tables already use the portable boolean helper public.is_member_of_org(uuid)
-- to avoid this set-vs-array policy shape mismatch.
--
-- This migration changes only policy shape. It does not broaden write access:
-- INSERT/UPDATE/DELETE keep the same page-permission + property-access gates.

ALTER TABLE public.rent_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_schedules_select" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_insert" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_update" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_delete" ON public.rent_schedules;

CREATE POLICY "rent_schedules_select" ON public.rent_schedules
  FOR SELECT USING (public.is_member_of_org(org_id));

CREATE POLICY "rent_schedules_insert" ON public.rent_schedules
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "rent_schedules_update" ON public.rent_schedules
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "rent_schedules_delete" ON public.rent_schedules
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );