-- Create a schema-safe lease delete RPC for environments where optional
-- lease/CAM/expense tables differ by migration age.

CREATE OR REPLACE FUNCTION public.delete_lease_cascade(target_lease_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  child_table TEXT;
  detach_table TEXT;
BEGIN
  IF target_lease_id IS NULL THEN
    RAISE EXCEPTION 'target_lease_id is required';
  END IF;

  FOREACH detach_table IN ARRAY ARRAY[
    'units',
    'documents',
    'uploaded_files'
  ]
  LOOP
    IF to_regclass(format('public.%I', detach_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = detach_table
           AND column_name = 'lease_id'
       )
    THEN
      EXECUTE format('UPDATE public.%I SET lease_id = NULL WHERE lease_id = $1', detach_table)
      USING target_lease_id;
    END IF;
  END LOOP;

  IF to_regclass('public.expense_classification_templates') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'expense_classification_templates'
         AND column_name = 'based_on_lease_id'
     )
  THEN
    UPDATE public.expense_classification_templates
    SET based_on_lease_id = NULL
    WHERE based_on_lease_id = target_lease_id;
  END IF;

  FOREACH child_table IN ARRAY ARRAY[
    'cam_expense_inputs',
    'expense_classifications',
    'expenses',
    'rent_projections',
    'rent_schedules',
    'revenues',
    'lease_critical_dates',
    'lease_clauses',
    'lease_field_reviews',
    'lease_config',
    'cam_profiles',
    'lease_amendments',
    'lease_assignments',
    'lease_expense_rule_clauses',
    'lease_expense_rules',
    'lease_expense_rule_sets'
  ]
  LOOP
    IF to_regclass(format('public.%I', child_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = child_table
           AND column_name = 'lease_id'
       )
    THEN
      EXECUTE format('DELETE FROM public.%I WHERE lease_id = $1', child_table)
      USING target_lease_id;
    END IF;
  END LOOP;

  DELETE FROM public.leases WHERE id = target_lease_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID) TO service_role;

