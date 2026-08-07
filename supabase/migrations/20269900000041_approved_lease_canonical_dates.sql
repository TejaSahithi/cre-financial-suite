-- Approved lease abstracts are the source of truth for reviewed lease dates.
-- Keep the canonical lease date columns populated for downstream CAM policy
-- materialization without guessing unresolved extraction values.

CREATE OR REPLACE FUNCTION public.approved_lease_snapshot_value(
  p_snapshot JSONB,
  VARIADIC p_keys TEXT[]
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key TEXT;
  v_entry JSONB;
  v_status TEXT;
  v_value TEXT;
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RETURN NULL;
  END IF;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_snapshot #> ARRAY['approved', v_key];
    IF v_entry IS NULL THEN
      CONTINUE;
    END IF;

    v_status := lower(trim(COALESCE(
      v_entry->>'review_status',
      v_entry->>'status',
      'accepted'
    )));

    IF v_status NOT IN ('accepted', 'edited', 'approved', 'reviewed') THEN
      CONTINUE;
    END IF;

    v_value := NULLIF(trim(COALESCE(
      v_entry->>'value',
      v_entry->>'normalized_value',
      v_entry->>'normalizedValue',
      v_entry->>'raw_value'
    )), '');

    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_snapshot #> ARRAY['fields', v_key];
    IF v_entry IS NULL THEN
      CONTINUE;
    END IF;

    v_status := lower(trim(COALESCE(
      v_entry->>'review_status',
      v_entry->>'status',
      ''
    )));

    IF v_status NOT IN ('accepted', 'edited', 'approved', 'reviewed') THEN
      CONTINUE;
    END IF;

    v_value := NULLIF(trim(COALESCE(
      v_entry->>'value',
      v_entry->>'normalized_value',
      v_entry->>'normalizedValue',
      v_entry->>'raw_value'
    )), '');

    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.approved_lease_snapshot_iso_date(
  p_snapshot JSONB,
  VARIADIC p_keys TEXT[]
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_value TEXT;
BEGIN
  v_value := public.approved_lease_snapshot_value(p_snapshot, VARIADIC p_keys);

  -- Do not parse natural-language dates here. The review/extraction layer
  -- must resolve dates to ISO first; unresolved dates should remain null so
  -- CAM readiness blocks instead of inventing an effective date.
  IF v_value IS NULL OR v_value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;

  RETURN v_value::DATE;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_approved_lease_canonical_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lease_date DATE;
  v_commencement DATE;
  v_expiration DATE;
  v_rent_commencement DATE;
BEGIN
  IF COALESCE(NEW.abstract_status, '') <> 'approved'
     AND COALESCE(NEW.status, '') <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.abstract_snapshot IS NULL
     OR jsonb_typeof(NEW.abstract_snapshot) <> 'object' THEN
    RETURN NEW;
  END IF;

  v_lease_date := public.approved_lease_snapshot_iso_date(
    NEW.abstract_snapshot,
    'lease_date',
    'lease_execution_date',
    'signed_date'
  );

  v_commencement := public.approved_lease_snapshot_iso_date(
    NEW.abstract_snapshot,
    'commencement_date',
    'start_date',
    'lease_start_date',
    'term_start_date'
  );

  v_expiration := public.approved_lease_snapshot_iso_date(
    NEW.abstract_snapshot,
    'expiration_date',
    'end_date',
    'lease_end_date',
    'term_end_date'
  );

  v_rent_commencement := public.approved_lease_snapshot_iso_date(
    NEW.abstract_snapshot,
    'rent_commencement_date',
    'rent_start_date',
    'rent_commencement'
  );

  IF v_lease_date IS NOT NULL THEN
    NEW.lease_date := v_lease_date;
  END IF;

  IF v_commencement IS NOT NULL THEN
    NEW.commencement_date := v_commencement;
    NEW.start_date := v_commencement;
  END IF;

  IF v_expiration IS NOT NULL THEN
    NEW.expiration_date := v_expiration;
    NEW.end_date := v_expiration;
  END IF;

  IF v_rent_commencement IS NOT NULL THEN
    NEW.rent_commencement_date := v_rent_commencement;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_sync_approved_lease_canonical_dates ON public.leases;
CREATE TRIGGER tr_sync_approved_lease_canonical_dates
BEFORE INSERT OR UPDATE OF status, abstract_status, abstract_snapshot
ON public.leases
FOR EACH ROW
EXECUTE FUNCTION public.sync_approved_lease_canonical_dates();
