-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-C:
-- provenance tracking for legacy-backfilled rows. Every table the backfill
-- can write to gets the same four columns so a reviewer can always tell
-- backfilled data apart from data a human explicitly entered/approved, and
-- so uncertain rows surface for review rather than being silently treated
-- as equally trustworthy.
-- ===========================================================================

ALTER TABLE public.lease_premises
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'primary' CHECK (source_type IN ('primary', 'legacy_backfill')),
  ADD COLUMN IF NOT EXISTS backfill_confidence NUMERIC CHECK (backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS backfill_derivation_method TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (review_status IN ('not_required', 'needs_review', 'reviewed', 'rejected'));

ALTER TABLE public.space_area_measurements
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'primary' CHECK (source_type IN ('primary', 'legacy_backfill')),
  ADD COLUMN IF NOT EXISTS backfill_confidence NUMERIC CHECK (backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS backfill_derivation_method TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (review_status IN ('not_required', 'needs_review', 'reviewed', 'rejected'));

ALTER TABLE public.space_occupancy_periods
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'primary' CHECK (source_type IN ('primary', 'legacy_backfill')),
  ADD COLUMN IF NOT EXISTS backfill_confidence NUMERIC CHECK (backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS backfill_derivation_method TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (review_status IN ('not_required', 'needs_review', 'reviewed', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_lease_premises_review_status ON public.lease_premises(org_id, review_status) WHERE review_status = 'needs_review';
CREATE INDEX IF NOT EXISTS idx_space_area_measurements_review_status ON public.space_area_measurements(org_id, review_status) WHERE review_status = 'needs_review';
CREATE INDEX IF NOT EXISTS idx_space_occupancy_periods_review_status ON public.space_occupancy_periods(org_id, review_status) WHERE review_status = 'needs_review';
