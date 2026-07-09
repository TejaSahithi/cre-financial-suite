-- Enterprise hardening Phase 6A-2: reconcile tr_lease_changed's duplicate
-- audit row for RPC-covered lease writes, without weakening audit coverage
-- for the ~12 still-direct-write call sites (LeaseUpload.jsx/LeaseReview.jsx/
-- ExtractionDebugPanel.jsx, inventoried in the Phase 6D write-path plan)
-- that remain fully dependent on this trigger for their only audit trail.
--
-- Confirmed directly against live data this session: a single lease
-- approval produces two audit_logs rows for the same event -- the
-- trigger's own `action: 'update'` row (fired by approve_lease_workflow's
-- `UPDATE public.leases`) and the RPC's own canonical `action:
-- 'lease_abstract_approved'` row. Unlike budgets (where every write path
-- was RPC-covered, so tr_budget_changed's audit insert could simply be
-- dropped -- see 20260709010000_budget_trigger_audit_reconciliation.sql),
-- `leases` is NOT fully RPC-covered: dropping fn_on_lease_changed's audit
-- insert outright would silently remove the only audit record for every
-- one of those ~12 direct-write paths. This migration only skips the
-- trigger's audit insert for the one RPC-covered write path that exists
-- today (approve_lease_workflow's UPDATE) and leaves the insert firing
-- normally for every other INSERT/UPDATE on `leases`.
--
-- Mechanism: a transaction-local GUC (`set_config(..., is_local => true)`,
-- equivalent to SET LOCAL, automatically reverts at transaction end --
-- COMMIT or ROLLBACK -- so it can never leak into another request/session).
-- approve_lease_workflow sets it immediately before its UPDATE; the trigger
-- checks it with `current_setting(..., missing_ok => true)`, which returns
-- NULL (not an error) for every other caller that never sets it, so the
-- audit insert fires exactly as it always has for direct writes.
--
-- delete_lease_cascade is not affected -- tr_lease_changed is
-- AFTER INSERT OR UPDATE only, it never fires on DELETE.
--
-- Notification side effects in fn_on_lease_changed (expiry alert,
-- budget-ready alert) are untouched -- only the audit_logs insert is
-- conditionally skipped.

CREATE OR REPLACE FUNCTION public.fn_on_lease_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    days_left INT;
BEGIN
    -- Audit Log (skipped when the RPC-covered write path already wrote its
    -- own canonical audit row in the same transaction -- see migration
    -- header comment).
    IF current_setting('app.skip_lease_audit_trigger', true) IS DISTINCT FROM 'true' THEN
        INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value, user_email)
        VALUES (NEW.org_id, 'Lease', NEW.id::text,
                CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
                CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
                CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
                CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END,
                COALESCE(NEW.created_by, 'system'));
    END IF;

    -- Expiry Notification (within 180 days)
    IF NEW.end_date IS NOT NULL THEN
        days_left := NEW.end_date - CURRENT_DATE;
        IF days_left > 0 AND days_left <= 180 THEN
            IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE type = 'lease_expiry' AND link = NEW.id::text AND is_read = FALSE) THEN
                INSERT INTO public.notifications (org_id, type, title, message, link, priority)
                VALUES (NEW.org_id, 'lease_expiry', 'Lease Expiration Alert',
                        format('%s''s lease expires in %s days (%s). Review renewal options.', NEW.tenant_name, days_left, NEW.end_date),
                        NEW.id::text,
                        CASE WHEN days_left <= 90 THEN 'high' ELSE 'medium' END);
            END IF;
        END IF;
    END IF;

    -- Budget Ready Notification
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'budget_ready' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority)
        VALUES (NEW.org_id, 'budget_approval', 'Lease Ready for Budget',
                format('%s''s lease has been validated and is now budget-ready.', NEW.tenant_name),
                'medium');
    END IF;

    RETURN NEW;
END;
$function$;

-- approve_lease_workflow: identical to the version in
-- 20260707030000_normalize_approve_lease_workflow_audit_shape.sql, with one
-- addition -- a transaction-local GUC set immediately before the
-- `UPDATE public.leases` statement so fn_on_lease_changed skips its
-- now-duplicate audit insert for this one write path.
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

  -- Skip fn_on_lease_changed's own audit_logs insert for this UPDATE --
  -- this RPC writes its own canonical row below in the same transaction.
  -- Transaction-local (SET LOCAL semantics): reverts automatically at
  -- COMMIT/ROLLBACK, never leaks to any other request.
  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

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

  -- Moved ahead of the audit_logs insert (was after it) so
  -- v_critical_date_ids is available to include in the audit row's metadata.
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

  -- Canonical-shape audit row: actor_user_id/actor_email/severity/source/
  -- workflow_run_id/before/after/metadata/property_id. before/after replace
  -- the legacy old_value/new_value text columns (left NULL, along with
  -- field_changed); metadata folds in the legacy fields that don't have a
  -- structured column of their own (signed_by, signed_at,
  -- approval_comments, approval_document_url, abstract_version,
  -- critical_date_ids).
  INSERT INTO public.audit_logs (
    org_id,
    property_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_email,
    severity,
    source,
    workflow_run_id,
    before,
    after,
    metadata,
    "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated_lease.property_id,
    'Lease',
    p_lease_id::TEXT,
    'lease_abstract_approved',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_run_id,
    to_jsonb(v_lease),
    to_jsonb(v_updated_lease),
    jsonb_build_object(
      'abstract_version', v_next_version,
      'signed_by', p_signed_by,
      'signed_at', p_signed_at,
      'approval_comments', p_approval_comments,
      'approval_document_url', p_approval_document_url,
      'critical_date_ids', COALESCE(v_critical_date_ids, '[]'::jsonb),
      'workflow_run_id', v_run_id,
      'idempotency_key', p_idempotency_key
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

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
