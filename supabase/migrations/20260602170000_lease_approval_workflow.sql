-- Hardening Sprint 1: server-owned lease approval core.
-- Additive only: records idempotent workflow runs and exposes one
-- transactional RPC for the Edge Function to call with service-role context.

CREATE TABLE IF NOT EXISTS public.lease_approval_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lease_approval_workflow_runs_lease
  ON public.lease_approval_workflow_runs (org_id, lease_id, created_at DESC);

ALTER TABLE public.lease_approval_workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_approval_workflow_runs_select" ON public.lease_approval_workflow_runs;
DROP POLICY IF EXISTS "lease_approval_workflow_runs_insert" ON public.lease_approval_workflow_runs;
DROP POLICY IF EXISTS "lease_approval_workflow_runs_update" ON public.lease_approval_workflow_runs;

CREATE POLICY "lease_approval_workflow_runs_select" ON public.lease_approval_workflow_runs
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "lease_approval_workflow_runs_insert" ON public.lease_approval_workflow_runs
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_approval_workflow_runs_update" ON public.lease_approval_workflow_runs
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_approval_workflow_runs_updated_at ON public.lease_approval_workflow_runs;
CREATE TRIGGER set_lease_approval_workflow_runs_updated_at
  BEFORE UPDATE ON public.lease_approval_workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

UPDATE public.documents
   SET title = COALESCE(NULLIF(title, ''), NULLIF(name, ''), 'Untitled Document')
 WHERE title IS NULL OR title = '';

UPDATE public.documents
   SET file_name = COALESCE(NULLIF(file_name, ''), NULLIF(name, ''), NULLIF(title, ''), 'document')
 WHERE file_name IS NULL OR file_name = '';

UPDATE public.documents
   SET storage_path = COALESCE(NULLIF(storage_path, ''), NULLIF(document_url, ''), NULLIF(file_url, ''), 'documents/' || id::text)
 WHERE storage_path IS NULL OR storage_path = '';

ALTER TABLE public.documents
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN file_name SET NOT NULL,
  ALTER COLUMN storage_path SET NOT NULL;

CREATE OR REPLACE FUNCTION public.approve_lease_workflow(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_signed_by TEXT,
  p_signed_at TIMESTAMPTZ,
  p_approval_comments TEXT,
  p_approval_document_url TEXT,
  p_field_reviews JSONB,
  p_abstract_snapshot JSONB,
  p_critical_dates JSONB,
  p_idempotency_key TEXT,
  p_request_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_run_id UUID;
  v_run public.lease_approval_workflow_runs%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_updated_lease public.leases%ROWTYPE;
  v_next_version INT;
  v_snapshot JSONB;
  v_audit_log_id UUID;
  v_document_id UUID;
  v_notification_id UUID;
  v_critical_date_ids JSONB := '[]'::jsonb;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_signed_by, '')), '') IS NULL THEN
    RAISE EXCEPTION 'signed_by is required';
  END IF;
  IF p_signed_at IS NULL THEN
    RAISE EXCEPTION 'signed_at is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  INSERT INTO public.lease_approval_workflow_runs (
    org_id,
    lease_id,
    idempotency_key,
    status,
    request_payload,
    actor_user_id,
    actor_email
  )
  VALUES (
    p_org_id,
    p_lease_id,
    p_idempotency_key,
    'started',
    COALESCE(p_request_payload, '{}'::jsonb),
    p_actor_user_id,
    p_actor_email
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_run_id;

  SELECT *
    INTO v_run
    FROM public.lease_approval_workflow_runs
   WHERE id = v_run_id
   FOR UPDATE;

  IF v_run.lease_id <> p_lease_id THEN
    RAISE EXCEPTION 'idempotency_key belongs to a different lease';
  END IF;

  IF v_run.status = 'completed' AND v_run.response_payload <> '{}'::jsonb THEN
    RETURN v_run.response_payload;
  END IF;

  SELECT *
    INTO v_lease
    FROM public.leases
   WHERE id = p_lease_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  IF COALESCE(v_lease.status, '') = 'approved'
     AND COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    v_response := jsonb_build_object(
      'lease', to_jsonb(v_lease),
      'abstract_version', COALESCE(v_lease.abstract_version, 1),
      'workflow_run_id', v_run_id,
      'audit_log_id', NULL,
      'document_id', NULL,
      'notification_id', NULL,
      'critical_date_ids', '[]'::jsonb,
      'already_approved', true
    );

    UPDATE public.lease_approval_workflow_runs
       SET status = 'completed',
           response_payload = v_response,
           completed_at = v_now,
           error_message = NULL
     WHERE id = v_run_id;

    RETURN v_response;
  END IF;

  v_next_version := COALESCE(v_lease.abstract_version, 0) + 1;
  v_snapshot := COALESCE(p_abstract_snapshot, '{}'::jsonb) ||
    jsonb_build_object(
      'version', v_next_version,
      'approved_at', v_now,
      'approved_by', p_signed_by
    );

  UPDATE public.leases
     SET status = 'approved',
         signed_by = p_signed_by,
         signed_at = p_signed_at,
         approval_comments = p_approval_comments,
         approval_document_url = p_approval_document_url,
         abstract_status = 'approved',
         abstract_version = v_next_version,
         abstract_approved_at = v_now,
         abstract_approved_by = p_signed_by,
         abstract_snapshot = v_snapshot,
         extraction_data = COALESCE(v_lease.extraction_data, '{}'::jsonb) ||
           jsonb_build_object(
             'field_reviews', COALESCE(p_field_reviews, '{}'::jsonb),
             'abstract', jsonb_build_object(
               'approved_at', v_now,
               'approved_by', p_signed_by,
               'version', v_next_version
             )
           ),
         extracted_fields = COALESCE(v_snapshot->'fields', '{}'::jsonb),
         updated_at = v_now
   WHERE id = p_lease_id
     AND org_id = p_org_id
   RETURNING * INTO v_updated_lease;

  INSERT INTO public.lease_field_reviews (
    org_id,
    lease_id,
    field_key,
    status,
    normalized_value,
    raw_value,
    source_page,
    source_text,
    confidence,
    note,
    reviewer,
    reviewed_at
  )
  SELECT
    p_org_id,
    p_lease_id,
    review.key,
    COALESCE(review.value->>'status', 'pending'),
    COALESCE(review.value->>'value', review.value->>'normalized_value'),
    review.value->>'raw_value',
    CASE
      WHEN COALESCE(review.value->>'source_page', '') ~ '^[0-9]+$'
        THEN (review.value->>'source_page')::INT
      ELSE NULL
    END,
    COALESCE(review.value->>'source_text', review.value->>'exact_source_text'),
    CASE
      WHEN COALESCE(review.value->>'confidence', '') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (review.value->>'confidence')::NUMERIC
      WHEN COALESCE(review.value->>'confidence_score', '') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (review.value->>'confidence_score')::NUMERIC
      ELSE NULL
    END,
    review.value->>'note',
    COALESCE(review.value->>'reviewer', p_signed_by),
    COALESCE(NULLIF(review.value->>'reviewed_at', '')::TIMESTAMPTZ, v_now)
  FROM jsonb_each(COALESCE(p_field_reviews, '{}'::jsonb)) AS review(key, value)
  ON CONFLICT (lease_id, field_key) DO UPDATE
    SET status = EXCLUDED.status,
        normalized_value = EXCLUDED.normalized_value,
        raw_value = EXCLUDED.raw_value,
        source_page = EXCLUDED.source_page,
        source_text = EXCLUDED.source_text,
        confidence = EXCLUDED.confidence,
        note = EXCLUDED.note,
        reviewer = EXCLUDED.reviewer,
        reviewed_at = EXCLUDED.reviewed_at,
        updated_at = now();

  INSERT INTO public.documents (
    org_id,
    property_id,
    lease_id,
    type,
    title,
    name,
    file_name,
    storage_path,
    file_url,
    status,
    signed_by,
    signed_at,
    comments,
    document_url
  )
  VALUES (
    p_org_id,
    v_updated_lease.property_id,
    p_lease_id,
    'lease',
    'Lease - ' || COALESCE(v_updated_lease.tenant_name, 'Unknown tenant'),
    'Lease - ' || COALESCE(v_updated_lease.tenant_name, 'Unknown tenant'),
    'Approved Lease Abstract v' || v_next_version || ' - ' || COALESCE(v_updated_lease.tenant_name, 'Unknown tenant'),
    COALESCE(
      NULLIF(p_approval_document_url, ''),
      'lease-approvals/' || p_org_id::TEXT || '/' || p_lease_id::TEXT || '/abstract-v' || v_next_version || '.json'
    ),
    p_approval_document_url,
    'approved',
    p_signed_by,
    p_signed_at,
    p_approval_comments,
    p_approval_document_url
  )
  RETURNING id INTO v_document_id;

  INSERT INTO public.notifications (
    org_id,
    type,
    title,
    message,
    link,
    priority
  )
  VALUES (
    p_org_id,
    'lease_approved',
    'Lease Abstract Approved',
    'Lease abstract v' || v_next_version || ' for ' ||
      COALESCE(v_updated_lease.tenant_name, 'tenant') ||
      ' approved. Signed by ' || p_signed_by || '.',
    '/LeaseReview?id=' || p_lease_id::TEXT,
    'normal'
  )
  RETURNING id INTO v_notification_id;

  INSERT INTO public.audit_logs (
    org_id,
    property_id,
    entity_type,
    entity_id,
    action,
    field_changed,
    old_value,
    new_value,
    actor_user_id,
    actor_email,
    severity,
    source,
    workflow_run_id,
    metadata,
    "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated_lease.property_id,
    'Lease',
    p_lease_id::TEXT,
    'lease_abstract_approved',
    'approval_status',
    NULL,
    jsonb_build_object(
      'abstract_version', v_next_version,
      'signed_by', p_signed_by,
      'signed_at', p_signed_at,
      'workflow_run_id', v_run_id,
      'idempotency_key', p_idempotency_key
    )::TEXT,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_run_id,
    jsonb_build_object(
      'abstract_version', v_next_version,
      'signed_by', p_signed_by,
      'signed_at', p_signed_at,
      'workflow_run_id', v_run_id,
      'idempotency_key', p_idempotency_key
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  IF jsonb_typeof(COALESCE(p_critical_dates, '[]'::jsonb)) = 'array' THEN
    WITH inserted AS (
      INSERT INTO public.lease_critical_dates (
        org_id,
        lease_id,
        property_id,
        date_type,
        due_date,
        status,
        reminder_days_before,
        source
      )
      SELECT
        p_org_id,
        p_lease_id,
        v_updated_lease.property_id,
        row.date_type,
        row.due_date,
        COALESCE(row.status, 'open'),
        row.reminder_days_before,
        COALESCE(row.source, 'derived')
      FROM jsonb_to_recordset(p_critical_dates) AS row(
        date_type TEXT,
        due_date DATE,
        status TEXT,
        reminder_days_before INT,
        source TEXT
      )
      WHERE row.date_type IS NOT NULL
        AND row.due_date IS NOT NULL
      ON CONFLICT (lease_id, date_type, due_date) DO NOTHING
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(id), '[]'::jsonb)
      INTO v_critical_date_ids
      FROM inserted;
  END IF;

  v_response := jsonb_build_object(
    'lease', to_jsonb(v_updated_lease),
    'abstract_version', v_next_version,
    'workflow_run_id', v_run_id,
    'audit_log_id', v_audit_log_id,
    'document_id', v_document_id,
    'notification_id', v_notification_id,
    'critical_date_ids', COALESCE(v_critical_date_ids, '[]'::jsonb),
    'already_approved', false
  );

  UPDATE public.lease_approval_workflow_runs
     SET status = 'completed',
         response_payload = v_response,
         completed_at = v_now,
         error_message = NULL
   WHERE id = v_run_id;

  RETURN v_response;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_lease_workflow(
  UUID,
  UUID,
  UUID,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT,
  TEXT,
  JSONB,
  JSONB,
  JSONB,
  TEXT,
  JSONB
) TO authenticated, service_role;
