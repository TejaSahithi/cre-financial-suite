-- Enterprise hardening Phase 6X-4: server-own expense single/bulk delete.
--
-- Expenses.jsx's single-delete and bulk-delete actions currently call
-- ExpenseService.delete(id) (the generic createEntityService('Expense')
-- factory, imported raw from @/services/api -- not the expenseService
-- wrapper): a direct client .delete().eq('id',id).eq('org_id',orgId) write
-- under the caller's own RLS session, per-id. Already permission-checked
-- (assertCurrentUserCanWrite) and already calls logAudit(), but that audit
-- is client-side, fire-and-forget, and its failure is silently swallowed --
-- the same unreliable-audit pattern already replaced for create (Phase
-- 6D-7), amount correction (Phase 6X-2), classification writes (Phase
-- 6X-1), and the AddExpense edit path (Phase 6X-3).
--
-- Bulk delete today (Expenses.jsx's bulkDeleteMutation) runs N independent
-- ExpenseService.delete(id) calls via Promise.all -- not atomic: if delete
-- #3 of 5 fails, deletes #1-2 have already committed and cannot be rolled
-- back. This RPC closes that gap: the whole batch is locked, validated,
-- and deleted in one transaction, or none of it is.
--
-- Dependent-record investigation (confirmed via direct FK inspection of the
-- live local schema, not assumed):
--   * expense_classifications.expense_id -> expenses(id) ON DELETE CASCADE.
--     Postgres cleans these up automatically when the expense row is
--     deleted -- no manual DELETE needed in this RPC, and this matches
--     today's raw-delete behavior exactly (the FK constraint already
--     enforces this regardless of which code path issues the DELETE).
--   * expense_classification_cam_send_runs.expense_id -> expenses(id)
--     ON DELETE SET NULL *in isolation* -- but in practice this row also
--     carries a NOT NULL classification_id -> expense_classifications(id)
--     ON DELETE CASCADE, and expense_classifications itself cascades from
--     expenses. Empirically verified (scratch transaction against local
--     Postgres, rolled back): deleting the expense deletes its
--     expense_classifications row, which in turn cascade-deletes the
--     cam_send_runs row entirely -- the expense_id SET NULL rule never
--     gets a chance to apply, since the row is gone before that update
--     would matter. This is existing FK-level behavior, unaffected by
--     which code path issues the DELETE -- not a regression introduced
--     by this RPC.
--   * lease_expense_values.mapped_expense_id -> expenses(id)
--     ON DELETE SET NULL. The rule's estimated-amount row is preserved,
--     mapping cleared -- same as today.
--   * cam_expense_inputs.actual_expense_id has NO foreign key constraint
--     to expenses at all (confirmed via pg_constraint) -- it's a
--     point-in-time snapshot table populated at CAM-send time, decoupled
--     from the source expense by design. Untouched today, untouched here.
--   * documents has no foreign key to expenses at all (only lease_id/
--     property_id/org_id). expenses.attachment_url is a plain text
--     storage path on the expenses row itself, not a join -- deleting the
--     expense row does not and never has removed the underlying storage
--     object; this RPC preserves that exact (non-)behavior, not a
--     regression.
--   * expenses has no AFTER DELETE trigger (tr_expense_added is
--     AFTER INSERT only, confirmed via pg_trigger) -- no GUC-skip needed.
--   * expenses has no soft-delete column of any kind -- hard delete is
--     preserved, matching current behavior exactly.
--
-- Whole-batch-atomic-or-nothing validation: every requested id must
-- resolve to a row in this org, locked FOR UPDATE, or the entire call
-- (single or bulk) is rejected with zero deletions and zero audit rows --
-- this is stricter than today's raw delete (which silently "succeeds" on
-- an id that doesn't exist or belongs to another org, since a
-- .delete().eq('id',id) that matches zero rows is not an error), but
-- matches every other RPC introduced this session (update_expense_amount,
-- update_expense_details) which reject unknown/cross-org ids explicitly
-- rather than silently no-op -- treated as closing a latent gap, not an
-- intended behavior to preserve.
--
-- One canonical audit_logs row per deleted expense (not one row for the
-- whole batch): each row carries its own full "before" snapshot and a
-- metadata.batch_ids pointer to its siblings, so a bulk delete of N
-- expenses produces N independently-reviewable audit entries -- consistent
-- with every other per-entity audit row this session has written
-- (expense_details_updated, expense_amount_corrected, etc.), and avoids
-- collapsing N distinct "before" states into one row's metadata.

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
