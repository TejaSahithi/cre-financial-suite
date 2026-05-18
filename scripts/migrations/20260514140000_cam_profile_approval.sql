-- Migration: 20260514140000_cam_profile_approval.sql
-- Description: Adds approval lifecycle and validation-warning fields to
--              cam_profiles so the new CAM Setup page can gate downstream
--              CAM Calculation on an approved profile. Additive only.

ALTER TABLE public.cam_profiles
  ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by         TEXT,
  ADD COLUMN IF NOT EXISTS validation_warnings JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes               TEXT;

COMMENT ON COLUMN public.cam_profiles.validation_warnings IS
  'List of reasons the CAM profile is not ready (e.g. missing building RSF, missing tenant share, no approved rule set).';

CREATE INDEX IF NOT EXISTS idx_cam_profiles_status
  ON public.cam_profiles (status);
