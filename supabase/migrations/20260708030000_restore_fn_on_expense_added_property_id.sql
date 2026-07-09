-- Remote deployment readiness prep, step 4 of 4.
--
-- The linked remote project's LIVE fn_on_expense_added() was hand-patched
-- directly on remote (not via any migration) to drop property_id from its
-- audit_logs insert, per its own in-body comment: "Audit Log (removed
-- property_id since the column doesn't exist in audit_logs)". The
-- migration-tracked version (20260622000001_fix_remaining_security_
-- definer_search_path.sql) has always included property_id -- remote was
-- silently running code no migration produces.
--
-- Now that 20260708010000_audit_logs_add_property_id.sql has added the
-- column, this CREATE OR REPLACE restores the migration-tracked body
-- (byte-for-byte identical to 20260622000001's version) so remote converges
-- back onto tracked history instead of keeping its hand-patched variant
-- after the rest of this branch is pushed. On local/fresh environments this
-- is a no-op re-apply of the function that is already running.
CREATE OR REPLACE FUNCTION public.fn_on_expense_added()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    total_actual   NUMERIC;
    total_budgeted NUMERIC;
    variance_pct   NUMERIC;
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, property_id, user_email)
    VALUES (NEW.org_id, 'Expense', NEW.id::text, 'create', NEW.property_id, COALESCE(NEW.created_by, 'system'));

    -- Recalculate Variance for this property and year
    IF NEW.property_id IS NOT NULL AND NEW.fiscal_year IS NOT NULL THEN
        SELECT SUM(amount)        INTO total_actual   FROM public.expenses WHERE property_id = NEW.property_id AND fiscal_year = NEW.fiscal_year;
        SELECT SUM(total_expenses) INTO total_budgeted FROM public.budgets  WHERE property_id = NEW.property_id AND budget_year = NEW.fiscal_year;

        IF total_budgeted > 0 THEN
            variance_pct := ((total_actual - total_budgeted) / total_budgeted) * 100;

            IF ABS(variance_pct) > 10 THEN
                INSERT INTO public.notifications (org_id, type, title, message, priority)
                VALUES (
                    NEW.org_id,
                    'cam_variance',
                    'Expense Variance Alert',
                    format(
                        'Total actual expenses ($%s) now %s%% %s budget ($%s) for FY %s.',
                        ROUND(total_actual, 2),
                        ROUND(ABS(variance_pct), 1),
                        CASE WHEN variance_pct > 0 THEN 'over' ELSE 'under' END,
                        ROUND(total_budgeted, 2),
                        NEW.fiscal_year
                    ),
                    CASE WHEN ABS(variance_pct) > 20 THEN 'high' ELSE 'medium' END
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
