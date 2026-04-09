-- ============================================================
-- Lease extended fields
--
-- Adds the renewal / escalation / CAM-recovery columns the
-- LeaseReview and LeaseUpload pages collect from extracted
-- lease documents. Without these the writes silently drop the
-- fields (the api allow-list strips unknown columns) and the
-- saved records show "—" on subsequent loads.
--
-- All ALTERs are idempotent.
-- ============================================================

ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS escalation_type             TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS escalation_timing           TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS renewal_type                TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS renewal_notice_months       INT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS cam_cap_type                TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS admin_fee_pct               NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS management_fee_basis        TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS hvac_responsibility         TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS sales_reporting_frequency   TEXT;
