-- Enterprise hardening Phase 6D-4: manage_lease_critical_date.
--
-- Moves criticalDateService.js's direct CRUD (createCriticalDate,
-- updateCriticalDate/assign-owner, markCriticalDateComplete,
-- deleteCriticalDate) behind a server-owned, audited RPC. Today these have
-- ZERO audit logging and ZERO permission check anywhere (confirmed:
-- src/pages/CriticalDates.jsx and criticalDateService.js contain no
-- logAudit/assertCurrentUserCanWrite calls at all).
--
-- Explicitly OUT of scope / untouched: approve_lease_workflow's own
-- lease_critical_dates INSERT (20260712000000, the "derived rows from
-- approved lease columns" path) is a completely separate code path already
-- covered by its own canonical audit row -- this RPC does not touch, call,
-- or interact with it in any way. Lease approval/rejection, critical-date
-- reads (listCriticalDates), and re-extraction are all untouched.
--
-- Actions supported (matching exactly what criticalDateService.js's
-- callers use today -- no "reopen/restore" exists in any current UI flow,
-- so it is not implemented here):
--   'create'        -- upsert on (lease_id, date_type, due_date), matching
--                       the client's existing onConflict behavior.
--   'update'         -- owner reassignment only (owner_email/owner_name),
--                       the only fields any current call site edits.
--   'mark_complete'  -- status='completed', completed_at=now(),
--                       completed_by=<free text, e.g. the row's existing
--                       owner -- matches CriticalDates.jsx's current
--                       completeMutation, which passes
--                       row.owner_name || row.owner_email, NOT the acting
--                       user's own identity; completed_by is a display
--                       column, not an audit-identity column>.
--   'delete'         -- hard delete, matching the client's current
--                       deleteCriticalDate.
--
-- No transaction-local audit-trigger-skip GUC is needed here: unlike
-- `leases`, `lease_critical_dates` has no AFTER INSERT/UPDATE trigger that
-- writes to audit_logs (only set_lease_critical_dates_updated_at, which
-- just bumps updated_at) -- confirmed via \d lease_critical_dates. So there
-- is no duplicate-audit-row risk to guard against for this table.
--
-- Patch whitelists are fixed per action (not user-suppliable field lists)
-- -- this RPC never accepts an arbitrary column patch.

CREATE OR REPLACE FUNCTION public.manage_lease_critical_date(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_action TEXT,              -- 'create' | 'update' | 'mark_complete' | 'delete'
  p_critical_date_id UUID,    -- required for update/mark_complete/delete; ignored for create
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_existing public.lease_critical_dates%ROWTYPE;
  v_target public.lease_critical_dates%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_action_name TEXT;
  v_deleted_id UUID;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF p_action NOT IN ('create', 'update', 'mark_complete', 'delete') THEN
    RAISE EXCEPTION 'action must be one of create, update, mark_complete, delete';
  END IF;
  IF p_action != 'create' AND p_critical_date_id IS NULL THEN
    RAISE EXCEPTION 'critical_date_id is required for action %', p_action;
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  IF p_action = 'create' THEN
    IF NOT (p_patch ?& ARRAY['due_date']) OR NULLIF(trim(p_patch->>'due_date'), '') IS NULL THEN
      RAISE EXCEPTION 'due_date is required to create a critical date';
    END IF;

    -- Reject arbitrary keys: only the fields the Add Reminder form actually
    -- sends are permitted.
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_patch) AS k
       WHERE k NOT IN ('date_type', 'due_date', 'owner_email', 'owner_name', 'reminder_days_before', 'note')
    ) THEN
      RAISE EXCEPTION 'patch contains a field not permitted for action=create';
    END IF;

    -- Pre-fetch a potential conflicting row (same lease/date_type/due_date)
    -- so the audit "before" image is accurate when this upsert lands on an
    -- existing row rather than truly creating a new one.
    SELECT * INTO v_existing
      FROM public.lease_critical_dates
     WHERE lease_id = p_lease_id
       AND date_type = COALESCE(p_patch->>'date_type', 'custom')
       AND due_date = (p_patch->>'due_date')::date
     FOR UPDATE;
    v_before := CASE WHEN FOUND THEN to_jsonb(v_existing) ELSE NULL END;

    INSERT INTO public.lease_critical_dates (
      org_id, lease_id, property_id, date_type, due_date,
      owner_email, owner_name, status, reminder_days_before, note, source
    )
    VALUES (
      p_org_id, p_lease_id, v_lease.property_id,
      COALESCE(p_patch->>'date_type', 'custom'),
      (p_patch->>'due_date')::date,
      NULLIF(p_patch->>'owner_email', ''),
      NULLIF(p_patch->>'owner_name', ''),
      'open',
      NULLIF(p_patch->>'reminder_days_before', '')::int,
      NULLIF(p_patch->>'note', ''),
      'manual'
    )
    ON CONFLICT (lease_id, date_type, due_date) DO UPDATE SET
      owner_email = EXCLUDED.owner_email,
      owner_name = EXCLUDED.owner_name,
      reminder_days_before = EXCLUDED.reminder_days_before,
      note = EXCLUDED.note,
      updated_at = v_now
    RETURNING * INTO v_target;

    v_action_name := 'lease_critical_date_created';
    v_after := to_jsonb(v_target);
  ELSE
    SELECT * INTO v_existing
      FROM public.lease_critical_dates
     WHERE id = p_critical_date_id
       AND org_id = p_org_id
       AND lease_id = p_lease_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Critical date not found for this lease/organization';
    END IF;
    v_before := to_jsonb(v_existing);

    IF p_action = 'update' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_patch) AS k
         WHERE k NOT IN ('owner_email', 'owner_name')
      ) THEN
        RAISE EXCEPTION 'patch contains a field not permitted for action=update';
      END IF;

      UPDATE public.lease_critical_dates
         SET owner_email = CASE WHEN p_patch ? 'owner_email' THEN NULLIF(p_patch->>'owner_email', '') ELSE owner_email END,
             owner_name = CASE WHEN p_patch ? 'owner_name' THEN NULLIF(p_patch->>'owner_name', '') ELSE owner_name END,
             updated_at = v_now
       WHERE id = p_critical_date_id AND org_id = p_org_id AND lease_id = p_lease_id
      RETURNING * INTO v_target;

      v_action_name := 'lease_critical_date_updated';
      v_after := to_jsonb(v_target);
    ELSIF p_action = 'mark_complete' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_patch) AS k
         WHERE k NOT IN ('completed_by')
      ) THEN
        RAISE EXCEPTION 'patch contains a field not permitted for action=mark_complete';
      END IF;

      UPDATE public.lease_critical_dates
         SET status = 'completed',
             completed_at = v_now,
             completed_by = CASE WHEN p_patch ? 'completed_by' THEN NULLIF(p_patch->>'completed_by', '') ELSE completed_by END,
             updated_at = v_now
       WHERE id = p_critical_date_id AND org_id = p_org_id AND lease_id = p_lease_id
      RETURNING * INTO v_target;

      v_action_name := 'lease_critical_date_completed';
      v_after := to_jsonb(v_target);
    ELSE -- delete
      DELETE FROM public.lease_critical_dates
       WHERE id = p_critical_date_id AND org_id = p_org_id AND lease_id = p_lease_id;

      v_action_name := 'lease_critical_date_deleted';
      v_deleted_id := p_critical_date_id;
      v_after := NULL;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_lease.property_id,
    'LeaseCriticalDate',
    COALESCE(v_target.id, v_deleted_id)::TEXT,
    v_action_name,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_before,
    v_after,
    jsonb_build_object('lease_id', p_lease_id, 'action', p_action),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'critical_date_id', COALESCE(v_target.id, v_deleted_id),
    'row', v_after,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by manage-lease-critical-date's assertPageAccess() call, so EXECUTE must
-- be restricted to service_role only (matching every other RPC introduced
-- this hardening pass).
REVOKE ALL ON FUNCTION public.manage_lease_critical_date(
  UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.manage_lease_critical_date(
  UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB
) TO service_role;
