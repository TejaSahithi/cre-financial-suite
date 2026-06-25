ALTER TABLE public.budgets
ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS rejection_comment text;

CREATE OR REPLACE FUNCTION public.fn_on_budget_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value)
    VALUES (
        NEW.org_id,
        'Budget',
        NEW.id::text,
        CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
        CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
        CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
        CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END
    );

    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority, link)
        VALUES (
            NEW.org_id,
            'budget_approval',
            'Budget Created',
            format('Budget "%s" (FY %s) has been generated.', NEW.name, NEW.budget_year),
            'low',
            NEW.id::text
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
        IF NEW.status = 'approved' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority, link)
            VALUES (
                NEW.org_id,
                'budget_approval',
                'Budget Approved',
                format('Budget "%s" (FY %s) has been approved.', NEW.name, NEW.budget_year),
                'medium',
                NEW.id::text
            );
        ELSIF NEW.status = 'locked' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority, link)
            VALUES (
                NEW.org_id,
                'budget_approval',
                'Budget Locked',
                format('Budget "%s" (FY %s) is now locked.', NEW.name, NEW.budget_year),
                'low',
                NEW.id::text
            );
        ELSIF NEW.status = 'under_review' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority, link)
            VALUES (
                NEW.org_id,
                'budget_approval',
                'Budget Submitted',
                format('Budget "%s" (FY %s) has been submitted for review.', NEW.name, NEW.budget_year),
                'medium',
                NEW.id::text
            );
        ELSIF NEW.status = 'reviewed' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority, link)
            VALUES (
                NEW.org_id,
                'budget_approval',
                'Budget Reviewed',
                format('Budget "%s" (FY %s) has been marked as reviewed.', NEW.name, NEW.budget_year),
                'medium',
                NEW.id::text
            );
        ELSIF NEW.status = 'draft' AND COALESCE(NEW.rejection_comment, '') <> '' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority, link)
            VALUES (
                NEW.org_id,
                'budget_approval',
                'Budget Sent Back for Rework',
                format(
                    'Budget "%s" (FY %s) was sent back for rework. Comments: %s',
                    NEW.name,
                    NEW.budget_year,
                    NEW.rejection_comment
                ),
                'high',
                NEW.id::text
            );
        END IF;
    ELSIF TG_OP = 'UPDATE'
      AND COALESCE(OLD.rejection_comment, '') IS DISTINCT FROM COALESCE(NEW.rejection_comment, '')
      AND COALESCE(NEW.rejection_comment, '') <> '' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority, link)
        VALUES (
            NEW.org_id,
            'budget_approval',
            'Budget Rework Comment Updated',
            format(
                'Budget "%s" (FY %s) has updated rework comments: %s',
                NEW.name,
                NEW.budget_year,
                NEW.rejection_comment
            ),
            'medium',
            NEW.id::text
        );
    END IF;

    RETURN NEW;
END;
$function$;
