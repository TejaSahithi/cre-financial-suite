-- Fix RLS policy on lease_field_reviews to allow users with lease write access
-- to approve/review fields.

DROP POLICY IF EXISTS "lease_field_reviews_insert" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_update" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_delete" ON public.lease_field_reviews;

CREATE POLICY "lease_field_reviews_insert" ON public.lease_field_reviews
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Leases'));

CREATE POLICY "lease_field_reviews_update" ON public.lease_field_reviews
  FOR UPDATE USING (public.can_write_page(org_id, 'Leases'));

CREATE POLICY "lease_field_reviews_delete" ON public.lease_field_reviews
  FOR DELETE USING (public.can_write_page(org_id, 'Leases'));
