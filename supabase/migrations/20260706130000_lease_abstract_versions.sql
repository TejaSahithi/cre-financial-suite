-- Enterprise hardening Phase 2: immutable lease abstract version history.
--
-- Today `leases.abstract_version` / `leases.abstract_snapshot` are columns on
-- the mutable `leases` row itself — each re-approval overwrites the previous
-- snapshot, so there is no queryable history of prior approved abstracts.
-- This migration adds an append-only version-history table and extends
-- approve_lease_workflow (CREATE OR REPLACE, same migration file it was
-- defined in) to insert into it in the same transaction as the existing
-- `leases` UPDATE, so every approval is both the fast "current" pointer
-- (unchanged) and a permanent, immutable history row.
--
-- Locked down by construction: no INSERT/UPDATE/DELETE policy is defined for
-- `authenticated`, only SELECT. The only writer is approve_lease_workflow,
-- which is SECURITY DEFINER and runs with elevated privileges regardless of
-- caller-level RLS. This is the target end-state Phase 6 will retrofit onto
-- older tables; this table starts there.

CREATE TABLE IF NOT EXISTS public.lease_abstract_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  version INT NOT NULL,
  abstract_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_reviews JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by TEXT,
  approved_at TIMESTAMPTZ NOT NULL,
  workflow_run_id UUID REFERENCES public.lease_approval_workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lease_id, version)
);

CREATE INDEX IF NOT EXISTS idx_lease_abstract_versions_lease
  ON public.lease_abstract_versions (org_id, lease_id, version DESC);

ALTER TABLE public.lease_abstract_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_abstract_versions_select" ON public.lease_abstract_versions;

-- Uses public.is_member_of_org() (20260709000000_add_is_member_of_org_helper.sql)
-- instead of get_my_org_ids(), which has diverged between local (RETURNS
-- SETOF uuid) and the linked remote project (RETURNS uuid[]) -- see that
-- migration's header comment for the full explanation.
CREATE POLICY "lease_abstract_versions_select" ON public.lease_abstract_versions
  FOR SELECT USING (public.is_member_of_org(org_id));

-- Extend approve_lease_workflow: insert the version-history row right after
-- the existing `leases` UPDATE, in the same transaction. Everything else in
-- the function body is unchanged from 20260602170000_lease_approval_workflow.sql
-- (as already corrected for the audit_logs column-shape fix).
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
  v_abstract_version_id UUID;
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
      'abstract_version_id', NULL,
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

  -- Immutable version-history row. One per (lease_id, version); the
  -- `leases` row above remains the fast "current" pointer.
  INSERT INTO public.lease_abstract_versions (
    org_id,
    lease_id,
    version,
    abstract_snapshot,
    field_reviews,
    approved_by,
    approved_at,
    workflow_run_id
  )
  VALUES (
    p_org_id,
    p_lease_id,
    v_next_version,
    v_snapshot,
    COALESCE(p_field_reviews, '{}'::jsonb),
    p_signed_by,
    v_now,
    v_run_id
  )
  ON CONFLICT (lease_id, version) DO NOTHING
  RETURNING id INTO v_abstract_version_id;

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
    'abstract_version_id', v_abstract_version_id,
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
