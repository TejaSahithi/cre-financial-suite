-- Repairs a latent bug in fn_protect_locked_budget (trigger
-- trg_protect_locked_budget, BEFORE UPDATE OR DELETE ON budgets, from
-- 20260904000000_budget_approval_signoff.sql), discovered while auditing
-- release readiness: every branch of the function ends with `RETURN NEW;`,
-- including the implicit fallthrough for a DELETE on a NON-locked budget.
-- `NEW` is always NULL for a DELETE trigger, and returning NULL from a
-- BEFORE DELETE trigger silently CANCELS the delete -- with no exception,
-- no error, nothing to tell the caller it didn't happen. The function's
-- own dedicated "Cannot delete a locked budget" exception was reachable
-- for a locked row only because the financial-values-changed check ABOVE
-- it already tripped first (NEW.total_revenue IS DISTINCT FROM
-- OLD.total_revenue is true when NEW is NULL), which is correct by
-- accident and reports the wrong message ("modify financial values"
-- instead of "cannot delete").
--
-- Investigated whether draft-budget deletion is a real, used capability
-- before deciding the fix: public.delete_organization_admin
-- (20260602014048_security_definer_search_path_hardening.sql), a
-- SECURITY DEFINER RPC wired to SuperAdmin.jsx's "Permanently delete
-- organization" action, runs `DELETE FROM public.budgets WHERE org_id =
-- target_org_id` with no status filter as part of a full org-teardown
-- cascade. Being SECURITY DEFINER bypasses budgets' RLS (budgets_delete
-- USING(false)), but NOT this BEFORE DELETE trigger -- so under the old
-- buggy behavior, deleting an org that owned any draft/reviewed budget
-- silently left those rows behind (orphaned once their org_id's FK target
-- vanishes upstream in the same cascade), while appearing to succeed.
--
-- Fix, matching the real, existing product workflow:
--   DELETE + status = 'locked'  -> explicit RAISE EXCEPTION (unchanged
--                                   intent, now reached directly with the
--                                   correct message instead of by accident
--                                   through the financial-diff check).
--   DELETE + status <> 'locked' -> RETURN OLD, letting the authorized
--                                   delete (e.g. delete_organization_admin)
--                                   actually proceed.
--   UPDATE                      -> unchanged: financial-value changes on a
--                                   locked row are still blocked; anything
--                                   else still proceeds via RETURN NEW.
-- No other behavior changes.
CREATE OR REPLACE FUNCTION public.fn_protect_locked_budget()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'locked' THEN
      RAISE EXCEPTION 'Cannot delete a locked budget (id: %). Create a new version instead.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'locked' THEN
    -- Allow updating metadata fields (like updated_at or audit logs if needed), but block financial changes or status regression
    IF (NEW.total_revenue IS DISTINCT FROM OLD.total_revenue OR
        NEW.total_expenses IS DISTINCT FROM OLD.total_expenses OR
        NEW.noi IS DISTINCT FROM OLD.noi OR
        NEW.cam_total IS DISTINCT FROM OLD.cam_total OR
        NEW.budget_year IS DISTINCT FROM OLD.budget_year OR
        NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
      RAISE EXCEPTION 'Cannot modify financial values of a locked budget (id: %). Create a new version instead.', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
