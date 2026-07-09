-- Remote deployment readiness prep, step 2 of 4.
--
-- audit_logs.property_id has existed since the original
-- 20260322_add_core_tables.sql CREATE TABLE IF NOT EXISTS, and is used by
-- every RPC/edge function in this hardening branch (approve_lease_workflow,
-- delete_lease_cascade, save_property_cam_config/save_lease_config,
-- persist_expense_classification, send_expense_classification_to_cam_workflow,
-- publish_lease_expense_rule_to_cam_workflow, compute-budget). On the linked
-- remote project, audit_logs already existed before this repo's migration
-- history began, so that CREATE TABLE IF NOT EXISTS was a silent no-op there
-- and property_id was never added. Deploying this branch's migrations to
-- remote without this column first would fail every one of the RPCs above
-- with 42703 on their first invocation. Must land before the rest of the
-- backlog (20260706120000 onward) is pushed to remote.
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL;
