-- Remove frontend write access to invoices
DROP POLICY IF EXISTS "invoices_insert" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update" ON public.invoices;
DROP POLICY IF EXISTS "invoices_delete" ON public.invoices;
DROP POLICY IF EXISTS "invoices_all" ON public.invoices;

-- Re-establish read access
CREATE POLICY "invoices_select_org" ON public.invoices
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_my_org_ids()));

-- Secure organizations.status column via trigger
CREATE OR REPLACE FUNCTION prevent_org_status_update()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_prevent_org_status_update ON public.organizations;
CREATE TRIGGER tr_prevent_org_status_update
BEFORE UPDATE ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION prevent_org_status_update();
