-- Enterprise hardening Phase 5B-1: harden the lease cascade-delete audit
-- trail. delete_lease_cascade (20260608173000_safe_delete_lease_cascade_rpc.sql)
-- performs a real, irreversible cascade delete but has never written its own
-- audit_logs row — the only audit record for this action has been a
-- fire-and-forget client-side logAudit() call in src/services/leaseService.js
-- with an unconditional `.catch(() => {})`, meaning the audit trail for
-- deleting a lease could silently vanish with zero error surfaced anywhere.
--
-- This migration extends the RPC to accept the acting user and insert one
-- audit_logs row in the same transaction as the delete itself, before the
-- lease row (and the org_id needed for the log) is gone.
--
-- The old single-parameter delete_lease_cascade(UUID) must be dropped
-- explicitly first: Postgres identifies functions by their full parameter
-- signature, so CREATE OR REPLACE with a different parameter list creates a
-- second, overloaded function rather than replacing the original — and a
-- call passing only target_lease_id would then be ambiguous between the two
-- (the new params have defaults, so both signatures could match). Dropping
-- the old one first guarantees exactly one delete_lease_cascade exists.

DROP FUNCTION IF EXISTS public.delete_lease_cascade(UUID);

CREATE OR REPLACE FUNCTION public.delete_lease_cascade(
  target_lease_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  child_table TEXT;
  detach_table TEXT;
  v_lease public.leases%ROWTYPE;
BEGIN
  IF target_lease_id IS NULL THEN
    RAISE EXCEPTION 'target_lease_id is required';
  END IF;

  -- Capture the lease's org_id/tenant_name before it's deleted — needed for
  -- the audit row below, and to confirm the lease actually exists.
  SELECT * INTO v_lease FROM public.leases WHERE id = target_lease_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found';
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

  INSERT INTO public.audit_logs (
    org_id,
    property_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_email,
    severity,
    source,
    before,
    metadata,
    "timestamp"
  )
  VALUES (
    v_lease.org_id,
    v_lease.property_id,
    'Lease',
    target_lease_id::TEXT,
    'delete',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    jsonb_build_object('tenant_name', v_lease.tenant_name),
    now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO service_role;
