-- Preserve CAM-specific lease and expense fields so they can flow into compute-cam.
-- Safe to run multiple times.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cam_applicable BOOLEAN,
  ADD COLUMN IF NOT EXISTS cam_cap NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cam_cap_rate NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS management_fee_pct NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS gross_up_clause BOOLEAN,
  ADD COLUMN IF NOT EXISTS allocation_method TEXT,
  ADD COLUMN IF NOT EXISTS weight_factor NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS base_year_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS expense_stop_amount NUMERIC(12,2);

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS allocation_type TEXT,
  ADD COLUMN IF NOT EXISTS allocation_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS direct_tenant_ids UUID[];

CREATE INDEX IF NOT EXISTS idx_leases_building_id ON public.leases(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_lease_id ON public.expenses(lease_id) WHERE lease_id IS NOT NULL;
