-- Migration: 20260514120000_approved_lease_abstract.sql
-- Description: Promotes the lease-review JSONB workflow into first-class
--              columns and a dedicated audit table. Additive only — existing
--              extraction_data.field_reviews / extraction_data.abstract values
--              from Phase 2 keep working and are backfilled into the new
--              structures so downstream queries are SQL-indexable.

-- 1. Add approved-lease-abstract columns to leases. The existing `status`
--    column already carries draft/approved/rejected; abstract_status is the
--    workflow-specific lifecycle for the lease abstract itself.
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS abstract_status       TEXT,
  ADD COLUMN IF NOT EXISTS abstract_version      INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abstract_approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS abstract_approved_by  TEXT,
  ADD COLUMN IF NOT EXISTS abstract_snapshot     JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.leases.abstract_status IS
  'Lease abstract lifecycle: draft | pending_review | approved | rejected | superseded.';
COMMENT ON COLUMN public.leases.abstract_snapshot IS
  'Frozen snapshot of the approved lease abstract (field values + review metadata) so downstream modules read from an immutable record per abstract_version.';

CREATE INDEX IF NOT EXISTS idx_leases_abstract_status
  ON public.leases (abstract_status)
  WHERE abstract_status IS NOT NULL;

-- 2. Backfill abstract_status from existing data so downstream queries can
--    filter for approved abstracts immediately. Leases approved before this
--    migration (status='approved') become abstract_status='approved' at
--    version 1; everything else is a draft.
UPDATE public.leases
   SET abstract_status      = 'approved',
       abstract_version     = COALESCE(NULLIF(abstract_version, 0), 1),
       abstract_approved_at = COALESCE(abstract_approved_at, signed_at, updated_at),
       abstract_approved_by = COALESCE(abstract_approved_by, signed_by)
 WHERE abstract_status IS NULL
   AND status = 'approved';

UPDATE public.leases
   SET abstract_status = 'draft'
 WHERE abstract_status IS NULL;

-- 3. Per-field review audit table. One row per (lease_id, field_key) — the
--    latest decision wins. History is preserved via abstract_snapshot on the
--    lease (each approved version freezes a copy).
CREATE TABLE IF NOT EXISTS public.lease_field_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id        UUID NOT NULL REFERENCES public.leases(id)        ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  status          TEXT NOT NULL,            -- pending | accepted | edited | rejected | not_applicable | needs_legal_review | manual_required
  normalized_value TEXT,                    -- stored as text to keep the table polymorphic
  raw_value       TEXT,
  source_page     INT,
  source_text     TEXT,
  confidence      NUMERIC,
  note            TEXT,
  reviewer        TEXT,
  reviewed_at     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_lease_field_reviews_lease
  ON public.lease_field_reviews (org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_field_reviews_status
  ON public.lease_field_reviews (lease_id, status);

ALTER TABLE public.lease_field_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_field_reviews_select" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_insert" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_update" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_delete" ON public.lease_field_reviews;

CREATE POLICY "lease_field_reviews_select" ON public.lease_field_reviews
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "lease_field_reviews_insert" ON public.lease_field_reviews
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_field_reviews_update" ON public.lease_field_reviews
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_field_reviews_delete" ON public.lease_field_reviews
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_field_reviews_updated_at ON public.lease_field_reviews;
CREATE TRIGGER set_lease_field_reviews_updated_at
  BEFORE UPDATE ON public.lease_field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- 4. Backfill the new audit table from existing extraction_data.field_reviews
--    so leases that were reviewed under the Phase 2 JSONB scheme keep their
--    history. Only inserts where no row exists yet for the (lease_id,
--    field_key) pair so re-running this migration is idempotent.
INSERT INTO public.lease_field_reviews
  (org_id, lease_id, field_key, status, normalized_value, raw_value,
   source_page, source_text, confidence, note, reviewer, reviewed_at)
SELECT
  l.org_id,
  l.id,
  fr.key                                          AS field_key,
  COALESCE(fr.value->>'status', 'pending')        AS status,
  fr.value->>'value'                              AS normalized_value,
  fr.value->>'raw_value'                          AS raw_value,
  NULLIF(fr.value->>'source_page','')::int        AS source_page,
  fr.value->>'source_text'                        AS source_text,
  NULLIF(fr.value->>'confidence','')::numeric     AS confidence,
  fr.value->>'note'                               AS note,
  COALESCE(fr.value->>'reviewer', l.signed_by)    AS reviewer,
  COALESCE(NULLIF(fr.value->>'reviewed_at','')::timestamptz, l.updated_at) AS reviewed_at
FROM public.leases l
CROSS JOIN LATERAL jsonb_each(COALESCE(l.extraction_data -> 'field_reviews', '{}'::jsonb)) AS fr(key, value)
ON CONFLICT (lease_id, field_key) DO NOTHING;

-- 5. Backfill abstract_snapshot from existing extraction_data.abstract for any
--    lease that already carries the JSONB shape from Phase 2.
UPDATE public.leases
   SET abstract_snapshot = jsonb_build_object(
         'version',        COALESCE((extraction_data->'abstract'->>'version')::int, 1),
         'approved_at',    extraction_data->'abstract'->>'approved_at',
         'approved_by',    extraction_data->'abstract'->>'approved_by',
         'fields',         extraction_data->'fields',
         'field_reviews',  extraction_data->'field_reviews'
       )
 WHERE abstract_snapshot = '{}'::jsonb
   AND extraction_data ? 'abstract';
