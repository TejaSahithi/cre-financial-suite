-- Migration: 20260877000000_create_delete_expenses_workflow_function.sql
-- Description: Define/recreate the delete_expenses_workflow RPC function to support atomic single/bulk expense deletions with audit logging.

CREATE OR REPLACE FUNCTION public.delete_expenses_workflow(
  p_org_id UUID,
  p_expense_ids UUID[],
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_requested_ids UUID[];
  v_found_ids UUID[];
  v_before_rows JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF p_expense_ids IS NULL OR array_length(p_expense_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'expense_ids is required';
  END IF;

  v_requested_ids := ARRAY(SELECT DISTINCT unnest(p_expense_ids));

  -- Lock every targeted row for the duration of this transaction before
  -- validating or deleting anything, so a concurrent writer can't slip in
  -- between the existence check and the delete.
  WITH locked AS (
    SELECT *
      FROM public.expenses
     WHERE id = ANY(v_requested_ids) AND org_id = p_org_id
     FOR UPDATE
  )
  SELECT array_agg(id), jsonb_agg(to_jsonb(locked))
    INTO v_found_ids, v_before_rows
    FROM locked;

  IF v_found_ids IS NULL
     OR array_length(v_found_ids, 1) IS DISTINCT FROM array_length(v_requested_ids, 1)
  THEN
    RAISE EXCEPTION 'One or more expense_ids were not found for this organization';
  END IF;

  DELETE FROM public.expenses
   WHERE id = ANY(v_found_ids) AND org_id = p_org_id;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  SELECT
    p_org_id,
    (elem->>'property_id')::UUID,
    'Expense',
    elem->>'id',
    'expense_deleted',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    elem,
    NULL,
    jsonb_build_object(
      'batch_size', array_length(v_found_ids, 1),
      'batch_ids', to_jsonb(v_found_ids)
    ),
    v_now
  FROM jsonb_array_elements(v_before_rows) AS elem;

  RETURN jsonb_build_object(
    'deleted_ids', to_jsonb(v_found_ids),
    'deleted_count', array_length(v_found_ids, 1)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_expenses_workflow(
  UUID, UUID[], UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.delete_expenses_workflow(
  UUID, UUID[], UUID, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';
