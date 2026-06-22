-- Patch fn_on_expense_added: the only remaining SECURITY DEFINER function
-- that was missing SET search_path. All others were covered by the
-- 20260602014048_security_definer_search_path_hardening migration.
--
-- Without SET search_path, a superuser could create a rogue schema before
-- public.memberships / public.audit_logs, causing the trigger to read/write
-- attacker-controlled tables. Adding SET search_path = public, pg_temp
-- locks the function to the public schema only.

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
