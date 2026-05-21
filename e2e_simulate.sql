DO $$
DECLARE
    v_lease_id UUID;
    v_expense_1 UUID;
    v_expense_2 UUID;
    v_expense_3 UUID;
    v_expense_4 UUID;
    v_rule_1 UUID;
    v_rule_2 UUID;
    v_rule_3 UUID;
BEGIN
    SELECT id INTO v_lease_id FROM public.leases WHERE property_id IS NOT NULL LIMIT 1;
    
    SELECT id INTO v_expense_1 FROM public.expenses WHERE category = 'insurance' AND lease_id = v_lease_id;
    SELECT id INTO v_expense_2 FROM public.expenses WHERE category = 'general_repairs' AND lease_id = v_lease_id;
    SELECT id INTO v_expense_3 FROM public.expenses WHERE category = 'utilities' AND lease_id = v_lease_id;
    SELECT id INTO v_expense_4 FROM public.expenses WHERE category = 'landscaping' AND lease_id = v_lease_id;

    SELECT id INTO v_rule_1 FROM public.lease_expense_rules WHERE expense_category = 'insurance' AND lease_id = v_lease_id;
    SELECT id INTO v_rule_2 FROM public.lease_expense_rules WHERE expense_category = 'general_repairs' AND lease_id = v_lease_id;
    SELECT id INTO v_rule_3 FROM public.lease_expense_rules WHERE expense_category = 'utilities' AND lease_id = v_lease_id;

    -- Clean old classifications
    DELETE FROM public.expense_classifications WHERE lease_id = v_lease_id;

    -- Simulate classification engine
    -- 1. Property Insurance -> matched, non-recoverable
    INSERT INTO public.expense_classifications (
        id, org_id, expense_id, actual_expense_id, lease_id, lease_expense_rule_id, 
        classification_status, recovery_status, recoverability_result, category, 
        amount, classification_key, row_type
    ) VALUES (
        gen_random_uuid(), (SELECT org_id FROM public.leases WHERE id = v_lease_id), 
        v_expense_1, v_expense_1, v_lease_id, v_rule_1, 
        'finalized', 'non_recoverable', 'non_recoverable', 'insurance', 
        1000, 'sim_1', 'matched_classification'
    );

    -- 2. Tenant Damage -> matched, recoverable
    INSERT INTO public.expense_classifications (
        id, org_id, expense_id, actual_expense_id, lease_id, lease_expense_rule_id, 
        classification_status, recovery_status, recoverability_result, category, 
        amount, cam_eligible, classification_key, row_type
    ) VALUES (
        gen_random_uuid(), (SELECT org_id FROM public.leases WHERE id = v_lease_id), 
        v_expense_2, v_expense_2, v_lease_id, v_rule_2, 
        'finalized', 'recoverable', 'recoverable', 'general_repairs', 
        500, 'yes', 'sim_2', 'matched_classification'
    );

    -- 3. Excess Utilities -> conditional
    INSERT INTO public.expense_classifications (
        id, org_id, expense_id, actual_expense_id, lease_id, lease_expense_rule_id, 
        classification_status, recovery_status, recoverability_result, category, 
        amount, classification_key, row_type
    ) VALUES (
        gen_random_uuid(), (SELECT org_id FROM public.leases WHERE id = v_lease_id), 
        v_expense_3, v_expense_3, v_lease_id, v_rule_3, 
        'conditional', 'conditional', 'conditional', 'utilities', 
        300, 'sim_3', 'matched_classification'
    );

    -- 4. Landscaping -> actual missing rule
    INSERT INTO public.expense_classifications (
        id, org_id, expense_id, actual_expense_id, lease_id,
        classification_status, recovery_status, recoverability_result, category, 
        amount, classification_key, row_type
    ) VALUES (
        gen_random_uuid(), (SELECT org_id FROM public.leases WHERE id = v_lease_id), 
        v_expense_4, v_expense_4, v_lease_id, 
        'unmatched', 'needs_review', 'needs_review', 'landscaping', 
        700, 'sim_4', 'actual_missing_rule'
    );
END $$;
