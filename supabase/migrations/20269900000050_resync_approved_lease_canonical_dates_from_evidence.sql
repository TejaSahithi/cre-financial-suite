-- Re-sync approved lease canonical date columns from approved evidence.
-- This keeps CAM policy materialization fail-closed without forcing reviewers
-- to hand-patch existing approved leases.

CREATE OR REPLACE FUNCTION public.approved_lease_json_value(p_entry JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_entry IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_entry) = 'object' THEN
    RETURN NULLIF(trim(COALESCE(
      p_entry->>'value',
      p_entry->>'normalized_value',
      p_entry->>'normalizedValue',
      p_entry->>'raw_value'
    )), '');
  END IF;

  IF jsonb_typeof(p_entry) IN ('string', 'number', 'boolean') THEN
    RETURN NULLIF(trim(BOTH '"' FROM p_entry::TEXT), '');
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.approved_lease_json_status(
  p_entry JSONB,
  p_default TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RETURN lower(trim(COALESCE(p_default, '')));
  END IF;

  RETURN lower(trim(COALESCE(
    p_entry->>'review_status',
    p_entry->>'status',
    p_default,
    ''
  )));
END;
$$;

CREATE OR REPLACE FUNCTION public.approved_lease_any_source_value(
  p_snapshot JSONB,
  p_extraction JSONB,
  p_extracted_fields JSONB,
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
  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_snapshot #> ARRAY['approved', v_key];
    v_status := public.approved_lease_json_status(v_entry, 'accepted');
    IF v_status IN ('accepted', 'edited', 'approved', 'reviewed') THEN
      v_value := public.approved_lease_json_value(v_entry);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_snapshot #> ARRAY['fields', v_key];
    v_status := public.approved_lease_json_status(v_entry, NULL);
    IF v_status IN ('accepted', 'edited', 'approved', 'reviewed') THEN
      v_value := public.approved_lease_json_value(v_entry);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_extraction #> ARRAY['field_reviews', v_key];
    v_status := public.approved_lease_json_status(v_entry, NULL);
    IF v_status IN ('accepted', 'edited', 'approved', 'reviewed') THEN
      v_value := public.approved_lease_json_value(v_entry);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_extraction #> ARRAY['workflow_output', 'lease_fields', v_key];
    v_value := public.approved_lease_json_value(v_entry);
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;

    v_entry := p_extraction #> ARRAY['workflow_output', 'records', '0', 'lease_fields', v_key];
    v_value := public.approved_lease_json_value(v_entry);
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_extraction #> ARRAY['fields', v_key];
    v_value := public.approved_lease_json_value(v_entry);
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY p_keys LOOP
    v_entry := p_extracted_fields -> v_key;
    v_value := public.approved_lease_json_value(v_entry);
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.approved_lease_any_source_iso_date(
  p_snapshot JSONB,
  p_extraction JSONB,
  p_extracted_fields JSONB,
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
  v_value := public.approved_lease_any_source_value(
    p_snapshot,
    p_extraction,
    p_extracted_fields,
    VARIADIC p_keys
  );

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

  v_lease_date := public.approved_lease_any_source_iso_date(
    NEW.abstract_snapshot,
    NEW.extraction_data,
    NEW.extracted_fields,
    'lease_date',
    'lease_execution_date',
    'signed_date'
  );

  v_commencement := public.approved_lease_any_source_iso_date(
    NEW.abstract_snapshot,
    NEW.extraction_data,
    NEW.extracted_fields,
    'commencement_date',
    'start_date',
    'lease_start_date',
    'term_start_date'
  );

  v_expiration := public.approved_lease_any_source_iso_date(
    NEW.abstract_snapshot,
    NEW.extraction_data,
    NEW.extracted_fields,
    'expiration_date',
    'end_date',
    'lease_end_date',
    'term_end_date'
  );

  v_rent_commencement := public.approved_lease_any_source_iso_date(
    NEW.abstract_snapshot,
    NEW.extraction_data,
    NEW.extracted_fields,
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
BEFORE INSERT OR UPDATE OF status, abstract_status, abstract_snapshot, extraction_data, extracted_fields
ON public.leases
FOR EACH ROW
EXECUTE FUNCTION public.sync_approved_lease_canonical_dates();

UPDATE public.leases
   SET abstract_snapshot = COALESCE(abstract_snapshot, '{}'::jsonb)
 WHERE (
   COALESCE(abstract_status, '') = 'approved'
   OR COALESCE(status, '') = 'approved'
 )
   AND (
     commencement_date IS NULL
     OR start_date IS NULL
     OR expiration_date IS NULL
     OR end_date IS NULL
     OR lease_date IS NULL
     OR rent_commencement_date IS NULL
   );
