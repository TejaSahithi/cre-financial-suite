-- Enterprise hardening Phase HARD-3B3B: leases UPDATE RLS lockdown.
--
-- Now that every live authenticated-client leases UPDATE path has been
-- removed or routed through a server-owned, service_role-only RPC
-- (update_lease_extraction_field, save_lease_review_draft,
-- reject_lease_abstract, send_lease_back_for_reextraction,
-- update_lease_field_and_columns, backfill_lease_evidence,
-- persist_lease_extraction_merge, link_lease_space_assignment,
-- approve_lease_workflow -- Phases HARD-3B1 through HARD-3B3A), this
-- migration locks direct authenticated UPDATE on `leases` the same way
-- every other hardened table in this epic was locked
-- (uploaded_files/budgets/expenses/expense_classifications/cam_profiles/
-- lease_critical_dates/lease_expense_rule_* all follow this identical
-- pattern: replace the named policy with USING(false)/WITH CHECK(false),
-- leave every other command's policy untouched).
--
-- Confirmed immediately before writing this migration (repo-wide grep):
-- zero remaining direct `supabase.from("leases").update(...)` call sites,
-- zero `leaseService.update()` callers, zero `updateLeaseStripMissing`/
-- `backfillLeaseSummaryFields` references anywhere in src/. The only
-- remaining `leases` writes are reads/selects, the ~9 service_role-only
-- RPCs listed above (all SECURITY DEFINER, bypass RLS entirely per
-- rolbypassrls=true), and deleteLeaseCascadeFallback's DELETE (a DELETE,
-- not an UPDATE -- untouched by this migration, and out of this phase's
-- scope per explicit instruction).
--
-- Local and remote `leases_update` policies are confirmed to use different
-- underlying expressions today (local: can_write_any_page(org_id,
-- ARRAY['Leases','LeaseUpload','LeaseReview']); remote:
-- can_write_page(org_id,'Leases') -- a pre-existing, already-documented
-- drift from HARD-3A, not fixed here). This migration replaces the policy
-- by its exact name on both environments regardless of that drift -- a
-- DROP POLICY IF EXISTS + CREATE POLICY pair works identically either way,
-- since both environments currently have a policy literally named
-- "leases_update".
--
-- leases_select / leases_select_super_admin / leases_insert / leases_delete
-- are untouched -- SELECT, INSERT, and DELETE continue to work exactly as
-- before. RLS stays enabled (already was). No FOR ALL policy is introduced
-- or exists on this table.

DROP POLICY IF EXISTS "leases_update" ON public.leases;

CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (false) WITH CHECK (false);
