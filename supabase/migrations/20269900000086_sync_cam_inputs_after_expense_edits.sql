-- Keep CAM published expense inputs wired to corrected Actual Expense rows.
--
-- CAM intentionally reads cam_expense_inputs, not raw expenses. Before this
-- migration, update_expense_details changed public.expenses but left the
-- already-published CAM input untouched, so CAM Setup/Runs could continue to
-- show the old amount/category/scope until a manual withdraw + republish.
--
-- This trigger preserves the publication ledger model: the old published CAM
-- input is marked superseded, a new published version is inserted from the
-- corrected source expense, and existing pool assignments are copied to the
-- new version. Draft/calculated CAM runs that consumed the old input are
-- marked stale; approved/posted runs remain immutable and are only reported in
-- the audit metadata for deliberate restatement.

CREATE OR REPLACE FUNCTION public.sync_cam_inputs_after_expense_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_published public.cam_expense_inputs%ROWTYPE;
  v_classification public.expense_classifications%ROWTYPE;
  v_new_input public.cam_expense_inputs%ROWTYPE;
  v_new_amount NUMERIC;
  v_new_fiscal_year INT;
  v_next_version INT;
  v_stale_runs INT := 0;
  v_posted_runs UUID[] := ARRAY[]::UUID[];
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.property_id,
    OLD.building_id,
    OLD.unit_id,
    OLD.lease_id,
    OLD.tenant_id,
    OLD.category,
    OLD.expense_category_id,
    OLD.amount,
    OLD.fiscal_year,
    OLD.service_period_start,
    OLD.service_period_end,
    OLD.expense_date,
    OLD.date
  ) IS NOT DISTINCT FROM ROW(
    NEW.property_id,
    NEW.building_id,
    NEW.unit_id,
    NEW.lease_id,
    NEW.tenant_id,
    NEW.category,
    NEW.expense_category_id,
    NEW.amount,
    NEW.fiscal_year,
    NEW.service_period_start,
    NEW.service_period_end,
    NEW.expense_date,
    NEW.date
  ) THEN
    RETURN NEW;
  END IF;

  FOR v_published IN
    SELECT *
      FROM public.cam_expense_inputs
     WHERE org_id = NEW.org_id
       AND actual_expense_id = NEW.id
       AND publication_status = 'published'
     FOR UPDATE
  LOOP
    SELECT *
      INTO v_classification
      FROM public.expense_classifications
     WHERE id = v_published.classification_result_id
       AND org_id = NEW.org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE public.expense_classifications
       SET property_id = NEW.property_id,
           building_id = NEW.building_id,
           unit_id = NEW.unit_id,
           lease_id = NEW.lease_id,
           tenant_id = NEW.tenant_id,
           category = COALESCE(NEW.category, category),
           expense_category_id = NEW.expense_category_id,
           amount = NEW.amount,
           service_period_start = COALESCE(NEW.service_period_start, NEW.billing_period_start, NEW.expense_date, NEW.date),
           service_period_end = COALESCE(NEW.service_period_end, NEW.billing_period_end, NEW.expense_date, NEW.date),
           updated_at = v_now
     WHERE id = v_classification.id
       AND org_id = NEW.org_id
     RETURNING * INTO v_classification;

    v_new_amount := COALESCE(v_classification.amount, NEW.amount, v_published.amount);
    v_new_fiscal_year := COALESCE(
      NEW.fiscal_year,
      CASE
        WHEN v_classification.service_period_start IS NOT NULL
          THEN EXTRACT(YEAR FROM v_classification.service_period_start)::INT
        WHEN NEW.expense_date IS NOT NULL
          THEN EXTRACT(YEAR FROM NEW.expense_date)::INT
        WHEN NEW.date IS NOT NULL
          THEN EXTRACT(YEAR FROM NEW.date)::INT
        ELSE v_published.fiscal_year
      END
    );

    SELECT COALESCE(MAX(publication_version), 0) + 1
      INTO v_next_version
      FROM public.cam_expense_inputs
     WHERE classification_result_id = v_classification.id;

    UPDATE public.cam_expense_inputs
       SET publication_status = 'superseded',
           withdrawal_reason = format('Superseded automatically after source expense %s was updated.', NEW.id),
           updated_at = v_now
     WHERE id = v_published.id;

    INSERT INTO public.cam_expense_inputs (
      org_id,
      property_id,
      building_id,
      unit_id,
      lease_id,
      tenant_id,
      actual_expense_id,
      classification_result_id,
      lease_expense_rule_id,
      expense_category_id,
      category,
      amount,
      recovery_method,
      allocation_basis,
      source,
      status,
      cam_source,
      cam_input_type,
      manual_cam_reviewed,
      manual_cam_reason,
      fiscal_year,
      service_period_start,
      service_period_end,
      sent_to_cam_at,
      sent_to_cam_by,
      publication_status,
      publication_version,
      previous_version_id,
      source_expense_updated_at,
      source_classification_updated_at,
      source_rule_updated_at,
      published_by,
      published_at,
      updated_at
    )
    VALUES (
      NEW.org_id,
      COALESCE(v_classification.property_id, NEW.property_id),
      COALESCE(v_classification.building_id, NEW.building_id),
      COALESCE(v_classification.unit_id, NEW.unit_id),
      COALESCE(v_classification.lease_id, NEW.lease_id),
      COALESCE(v_classification.tenant_id, NEW.tenant_id),
      NEW.id,
      v_classification.id,
      v_published.lease_expense_rule_id,
      COALESCE(v_classification.expense_category_id, NEW.expense_category_id, v_published.expense_category_id),
      COALESCE(v_classification.category, NEW.category, v_published.category),
      v_new_amount,
      COALESCE(v_classification.recovery_method, v_published.recovery_method),
      COALESCE(v_classification.allocation_basis, v_classification.allocation_method, v_published.allocation_basis),
      v_published.source,
      v_published.status,
      v_published.cam_source,
      v_published.cam_input_type,
      v_published.manual_cam_reviewed,
      v_published.manual_cam_reason,
      v_new_fiscal_year,
      COALESCE(v_classification.service_period_start, NEW.service_period_start, NEW.billing_period_start, NEW.expense_date, NEW.date),
      COALESCE(v_classification.service_period_end, NEW.service_period_end, NEW.billing_period_end, NEW.expense_date, NEW.date),
      v_now,
      v_published.sent_to_cam_by,
      'published',
      v_next_version,
      v_published.id,
      NEW.updated_at,
      v_classification.updated_at,
      v_published.source_rule_updated_at,
      v_published.published_by,
      v_now,
      v_now
    )
    RETURNING * INTO v_new_input;

    INSERT INTO public.cam_input_pool_assignments (
      org_id,
      cam_expense_input_id,
      recovery_pool_id,
      amount,
      assignment_method,
      approved_by,
      created_at,
      updated_at
    )
    SELECT
      a.org_id,
      v_new_input.id,
      a.recovery_pool_id,
      CASE
        WHEN COALESCE(v_published.amount, 0) > 0
          THEN round((a.amount / v_published.amount) * v_new_amount, 6)
        ELSE v_new_amount
      END,
      a.assignment_method,
      a.approved_by,
      v_now,
      v_now
    FROM public.cam_input_pool_assignments a
    JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id
    WHERE a.org_id = NEW.org_id
      AND a.cam_expense_input_id = v_published.id
      AND rp.property_id = v_new_input.property_id
    ON CONFLICT (org_id, cam_expense_input_id, recovery_pool_id) DO UPDATE
      SET amount = EXCLUDED.amount,
          assignment_method = EXCLUDED.assignment_method,
          approved_by = EXCLUDED.approved_by,
          updated_at = EXCLUDED.updated_at;

    UPDATE public.cam_runs r
       SET stale = true,
           stale_reason = format('Source expense %s changed after CAM input %s was published.', NEW.id, v_published.id),
           stale_at = v_now,
           updated_at = v_now
     WHERE r.org_id = NEW.org_id
       AND r.status NOT IN ('approved', 'posted', 'superseded', 'voided')
       AND EXISTS (
         SELECT 1
           FROM public.cam_input_pool_assignments a
           JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id
          WHERE a.cam_expense_input_id = v_published.id
            AND rp.period_id = r.recovery_period_id
       );
    GET DIAGNOSTICS v_stale_runs = ROW_COUNT;

    SELECT COALESCE(array_agg(r.id), ARRAY[]::UUID[])
      INTO v_posted_runs
      FROM public.cam_runs r
     WHERE r.org_id = NEW.org_id
       AND r.status IN ('approved', 'posted')
       AND EXISTS (
         SELECT 1
           FROM public.cam_input_pool_assignments a
           JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id
          WHERE a.cam_expense_input_id = v_published.id
            AND rp.period_id = r.recovery_period_id
       );

    IF v_new_fiscal_year IS NOT NULL THEN
      PERFORM 1
        FROM public.mark_cam_snapshots_stale(
          NEW.org_id,
          v_published.property_id,
          CASE
            WHEN v_published.unit_id IS NOT NULL THEN 'unit'
            WHEN v_published.building_id IS NOT NULL THEN 'building'
            WHEN v_published.property_id IS NOT NULL THEN 'property'
            ELSE NULL
          END,
          COALESCE(v_published.unit_id, v_published.building_id, v_published.property_id),
          v_published.fiscal_year,
          format('Source expense %s changed after CAM input %s was published.', NEW.id, v_published.id)
        );

      PERFORM 1
        FROM public.mark_cam_snapshots_stale(
          NEW.org_id,
          v_new_input.property_id,
          CASE
            WHEN v_new_input.unit_id IS NOT NULL THEN 'unit'
            WHEN v_new_input.building_id IS NOT NULL THEN 'building'
            WHEN v_new_input.property_id IS NOT NULL THEN 'property'
            ELSE NULL
          END,
          COALESCE(v_new_input.unit_id, v_new_input.building_id, v_new_input.property_id),
          v_new_fiscal_year,
          format('Source expense %s was republished to CAM input %s.', NEW.id, v_new_input.id)
        );
    END IF;

    INSERT INTO public.audit_logs (
      org_id,
      property_id,
      entity_type,
      entity_id,
      action,
      severity,
      source,
      before,
      after,
      metadata,
      "timestamp"
    )
    VALUES (
      NEW.org_id,
      v_new_input.property_id,
      'CamExpenseInput',
      v_new_input.id::TEXT,
      'cam_expense_input_republished_after_expense_edit',
      'warning',
      'system',
      to_jsonb(v_published),
      to_jsonb(v_new_input),
      jsonb_build_object(
        'expense_id', NEW.id,
        'classification_id', v_classification.id,
        'previous_cam_expense_input_id', v_published.id,
        'new_cam_expense_input_id', v_new_input.id,
        'previous_amount', v_published.amount,
        'new_amount', v_new_input.amount,
        'draft_runs_marked_stale', v_stale_runs,
        'posted_runs_requiring_restatement', to_jsonb(v_posted_runs)
      ),
      v_now
    );
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_cam_inputs_after_expense_update ON public.expenses;
CREATE TRIGGER trg_sync_cam_inputs_after_expense_update
  AFTER UPDATE OF
    property_id,
    building_id,
    unit_id,
    lease_id,
    tenant_id,
    category,
    expense_category_id,
    amount,
    fiscal_year,
    service_period_start,
    service_period_end,
    expense_date,
    date
  ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_cam_inputs_after_expense_update();

NOTIFY pgrst, 'reload schema';
