-- Migration: Add transactional RPC for cascading lease deletes
-- File: 20260527120000_lease_cascade_rpc.sql
-- Description: Safely handles cascading delete of all lease-dependent data in a single transaction.

CREATE OR REPLACE FUNCTION public.delete_lease_cascade(target_lease_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Detach intentional preserved entities
  UPDATE public.units 
  SET lease_id = NULL 
  WHERE lease_id = target_lease_id;

  UPDATE public.uploaded_files 
  SET lease_id = NULL 
  WHERE lease_id = target_lease_id;

  UPDATE public.expense_classification_templates 
  SET based_on_lease_id = NULL 
  WHERE based_on_lease_id = target_lease_id;

  -- 2. Delete explicitly tracked dependencies
  -- Bottom-up deletion to respect standard constraints, though many lack direct FKs
  
  DELETE FROM public.cam_expense_inputs WHERE lease_id = target_lease_id;
  DELETE FROM public.expense_classifications WHERE lease_id = target_lease_id;
  DELETE FROM public.expenses WHERE lease_id = target_lease_id;
  DELETE FROM public.rent_projections WHERE lease_id = target_lease_id;
  DELETE FROM public.rent_schedules WHERE lease_id = target_lease_id;
  DELETE FROM public.revenues WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_critical_dates WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_clauses WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_field_reviews WHERE lease_id = target_lease_id;
  
  -- The expense rules hierarchy
  DELETE FROM public.lease_expense_rule_clauses WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_expense_rules WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_expense_rule_sets WHERE lease_id = target_lease_id;

  -- 3. Finally delete the lease itself
  DELETE FROM public.leases WHERE id = target_lease_id;
END;
$$;
