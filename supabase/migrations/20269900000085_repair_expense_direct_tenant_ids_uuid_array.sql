-- Repair expense detail updates on environments where direct_tenant_ids was
-- created as text[] before the canonical CAM allocation contract settled on
-- uuid[]. update_expense_details parses incoming tenant ids as uuid[], and a
-- text[] column makes its CASE expression fail with:
--   CASE/WHEN could not convert type uuid[] to text[]

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS direct_tenant_ids UUID[];

CREATE OR REPLACE FUNCTION public._coerce_text_array_to_uuid_array(values_in TEXT[])
RETURNS UUID[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN values_in IS NULL THEN NULL::UUID[]
    ELSE COALESCE(
      ARRAY(
        SELECT tenant_id::UUID
        FROM unnest(values_in) AS tenant_id
        WHERE tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ),
      ARRAY[]::UUID[]
    )
  END;
$$;

ALTER TABLE public.expenses
  ALTER COLUMN direct_tenant_ids TYPE UUID[]
  USING public._coerce_text_array_to_uuid_array(direct_tenant_ids::TEXT[]);

DROP FUNCTION IF EXISTS public._coerce_text_array_to_uuid_array(TEXT[]);

COMMENT ON COLUMN public.expenses.direct_tenant_ids IS
  'Tenant ids for direct expense allocation. Canonical type is uuid[]; migration 20269900000085 normalizes older text[] deployments.';

NOTIFY pgrst, 'reload schema';
