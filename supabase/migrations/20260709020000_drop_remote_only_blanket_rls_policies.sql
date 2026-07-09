-- Phase 6B-1: remote-only blanket RLS drift cleanup.
--
-- Investigation (Phase 6B) found the linked remote project carries a set
-- of blanket, pre-migration-history permissive policies -- <table>_all
-- (FOR ALL, org_id = ANY(get_my_org_ids())) on leases/expenses/properties/
-- buildings/portfolios/tenants/units/vendors, and four per-command
-- <table>_own_org variants on documents -- none of which are created by
-- any migration in this repo (same drift pattern already found and fixed
-- for budgets_all). None of these tables have any page-permission gating
-- in the blanket policies, so any org member bypasses can_write_page()/
-- can_access_property() entirely today, and any future per-table RLS
-- lockdown for these tables would be silently defeated the same way the
-- budgets lockdown was until budgets_all was dropped.
--
-- This migration only drops the remote-only blanket policies. It does not
-- touch documents' org_members_documents or super_admin_all_documents
-- (both tracked by 202604130146112_lease_approval_and_documents.sql and
-- live on both environments -- removing those is a separate, deliberate
-- decision, not drift cleanup), and does not touch any named per-command
-- policy (leases_select/_insert/_update/_delete, etc.), which remain the
-- sole active gate for these tables going forward.
--
-- Safe no-op on local and any fresh environment, where none of these
-- policies have ever existed.
DROP POLICY IF EXISTS "leases_all" ON public.leases;
DROP POLICY IF EXISTS "expenses_all" ON public.expenses;
DROP POLICY IF EXISTS "properties_all" ON public.properties;
DROP POLICY IF EXISTS "buildings_all" ON public.buildings;
DROP POLICY IF EXISTS "portfolios_all" ON public.portfolios;
DROP POLICY IF EXISTS "tenants_all" ON public.tenants;
DROP POLICY IF EXISTS "units_all" ON public.units;
DROP POLICY IF EXISTS "vendors_all" ON public.vendors;
DROP POLICY IF EXISTS "documents_select_own_org" ON public.documents;
DROP POLICY IF EXISTS "documents_insert_own_org" ON public.documents;
DROP POLICY IF EXISTS "documents_update_own_org" ON public.documents;
DROP POLICY IF EXISTS "documents_delete_own_org" ON public.documents;
