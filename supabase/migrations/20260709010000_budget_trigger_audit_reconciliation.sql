-- Phase 6A-1: budget audit-trigger reconciliation.
--
-- tr_budget_changed (AFTER INSERT OR UPDATE ON budgets, from
-- 20260322_add_core_tables.sql) fires on every write to `budgets` and
-- writes its own audit_logs row, independent of and in addition to
-- compute-budget's own canonical audit inserts (action: 'budget_generated'
-- and the mark_reviewed/reject/approve/lock actions added in later
-- phases). Since budgets is now fully RPC-owned (every write path goes
-- through compute-budget) and direct client writes are RLS-blocked
-- (20260707000000_budgets_rls_lockdown.sql /
-- 20260707010000_budgets_delete_lockdown.sql), this trigger's audit insert
-- is now purely redundant -- every budget write already gets a canonical
-- row from compute-budget itself.
--
-- fn_on_budget_changed is NOT audit-only, though: it also drives real
-- notification side effects (Budget Created/Approved/Locked/Submitted/
-- Reviewed/Sent-back-for-rework/Rework-comment-updated), so the trigger
-- itself must stay -- only its audit_logs insert is removed.
--
-- This also incidentally corrects a separate, unrelated drift found while
-- inspecting this function: the linked remote project's live
-- fn_on_budget_changed was still running the ORIGINAL 20260322 body
-- (missing the 'Reviewed'/'Sent Back for Rework'/'Rework Comment Updated'
-- notification branches and the `link` column added later by
-- 20260410000000_budget_review_workflow_metadata.sql), despite that
-- migration showing as applied in migration history. This CREATE OR
-- REPLACE restores the full, currently-tracked notification body (byte-
-- for-byte identical to 20260410000000's version) and removes only the
-- audit_logs insert -- no other behavior changes.
CREATE OR REPLACE FUNCTION public.fn_on_budget_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
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
