-- Add missing columns to public.budgets
ALTER TABLE public.budgets
ADD COLUMN IF NOT EXISTS ai_insights text,
ADD COLUMN IF NOT EXISTS building_id uuid REFERENCES public.buildings(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS cam_total numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS generation_method text,
ADD COLUMN IF NOT EXISTS noi numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS period text,
ADD COLUMN IF NOT EXISTS portfolio_id uuid REFERENCES public.portfolios(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS scope text,
ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES public.units(id) ON DELETE SET NULL;

-- Create or replace the trigger function
CREATE OR REPLACE FUNCTION public.fn_on_budget_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value)
    VALUES (NEW.org_id, 'Budget', NEW.id::text, 
            CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END);

    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority)
        VALUES (NEW.org_id, 'budget_approval', 'Budget Created', format('Budget "%s" (FY %s) has been generated.', NEW.name, NEW.budget_year), 'low');
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
        IF NEW.status = 'approved' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Approved', format('Budget "%s" (FY %s) has been approved.', NEW.name, NEW.budget_year), 'medium');
        ELSIF NEW.status = 'locked' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Locked', format('Budget "%s" (FY %s) is now locked.', NEW.name, NEW.budget_year), 'low');
        ELSIF NEW.status = 'under_review' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Submitted', format('Budget "%s" (FY %s) has been submitted for review.', NEW.name, NEW.budget_year), 'medium');
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;
