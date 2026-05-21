DO $$
DECLARE
    v_org_id UUID;
    v_tenant_id UUID;
    v_lease_id UUID;
    v_property_id UUID;
    v_building_id UUID;
    v_unit_id UUID;
    v_rule_set_id UUID;
    v_rule_1_id UUID := gen_random_uuid();
    v_rule_2_id UUID := gen_random_uuid();
    v_rule_3_id UUID := gen_random_uuid();
    v_expense_1_id UUID := gen_random_uuid();
    v_expense_2_id UUID := gen_random_uuid();
    v_expense_3_id UUID := gen_random_uuid();
    v_expense_4_id UUID := gen_random_uuid();
BEGIN
    -- 1. Grab IDs
    SELECT org_id INTO v_org_id FROM public.leases WHERE org_id IS NOT NULL LIMIT 1;
    SELECT id, property_id, building_id INTO v_lease_id, v_property_id, v_building_id 
    FROM public.leases WHERE property_id IS NOT NULL LIMIT 1;
    
    -- Ensure tenant and unit exist
    SELECT id INTO v_tenant_id FROM public.tenants LIMIT 1;
    SELECT id INTO v_unit_id FROM public.units WHERE property_id = v_property_id LIMIT 1;
    
    UPDATE public.leases SET tenant_id = v_tenant_id WHERE id = v_lease_id;
    UPDATE public.units SET tenant_id = v_tenant_id, lease_id = v_lease_id WHERE id = v_unit_id;

    -- Clean old data for this lease
    DELETE FROM public.expense_classifications WHERE lease_id = v_lease_id;
    DELETE FROM public.expenses WHERE lease_id = v_lease_id;
    DELETE FROM public.lease_expense_rules WHERE lease_id = v_lease_id;
    
    -- 2. Rules
    -- We need a rule set
    INSERT INTO public.lease_expense_rule_sets (id, org_id, lease_id, status)
    VALUES (gen_random_uuid(), v_org_id, v_lease_id, 'published')
    RETURNING id INTO v_rule_set_id;
    
    -- Property Insurance: included_in_base_rent = true, recoverable_from_tenant = no, cam_eligible = no
    INSERT INTO public.lease_expense_rules (id, org_id, lease_id, rule_set_id, expense_category, included_in_base_rent, recoverable_from_tenant, cam_eligible, approval_status, review_status, row_status)
    VALUES (v_rule_1_id, v_org_id, v_lease_id, v_rule_set_id, 'insurance', 'yes', 'no', 'no', 'approved', 'approved', 'manually_added');
    
    -- Tenant Damage: included_in_base_rent = false, recoverable_from_tenant = yes, cam_eligible = yes, recovery_method = direct_bill
    INSERT INTO public.lease_expense_rules (id, org_id, lease_id, rule_set_id, expense_category, expense_subcategory, included_in_base_rent, recoverable_from_tenant, cam_eligible, recovery_method, approval_status, review_status, row_status)
    VALUES (v_rule_2_id, v_org_id, v_lease_id, v_rule_set_id, 'general_repairs', 'tenant_damage', 'no', 'yes', 'yes', 'direct_bill', 'approved', 'approved', 'manually_added');
    
    -- Excess Utilities: recoverable_from_tenant = conditional, cam_eligible = conditional, recovery_method = actual_usage
    INSERT INTO public.lease_expense_rules (id, org_id, lease_id, rule_set_id, expense_category, included_in_base_rent, recoverable_from_tenant, cam_eligible, recovery_method, approval_status, review_status, row_status)
    VALUES (v_rule_3_id, v_org_id, v_lease_id, v_rule_set_id, 'utilities', 'no', 'conditional', 'conditional', 'actual_usage', 'approved', 'approved', 'manually_added');
    
    -- 3. Expenses
    -- Property Insurance, 1000
    INSERT INTO public.expenses (id, org_id, property_id, building_id, unit_id, lease_id, tenant_id, category, amount, approval_status, review_status, date, service_period_start, service_period_end)
    VALUES (v_expense_1_id, v_org_id, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id, 'insurance', 1000, 'approved', 'approved', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE);

    -- Tenant Damage, 500
    INSERT INTO public.expenses (id, org_id, property_id, building_id, unit_id, lease_id, tenant_id, category, amount, approval_status, review_status, date, service_period_start, service_period_end)
    VALUES (v_expense_2_id, v_org_id, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id, 'general_repairs', 500, 'approved', 'approved', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE);

    -- Excess Utilities, 300
    INSERT INTO public.expenses (id, org_id, property_id, building_id, unit_id, lease_id, tenant_id, category, amount, approval_status, review_status, date, service_period_start, service_period_end)
    VALUES (v_expense_3_id, v_org_id, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id, 'utilities', 300, 'approved', 'approved', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE);

    -- Landscaping, 700
    INSERT INTO public.expenses (id, org_id, property_id, building_id, unit_id, lease_id, tenant_id, category, amount, approval_status, review_status, date, service_period_start, service_period_end)
    VALUES (v_expense_4_id, v_org_id, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id, 'landscaping', 700, 'approved', 'approved', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE);

END $$;
