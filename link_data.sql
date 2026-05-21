DO $$
DECLARE
    v_tenant_id UUID;
    v_lease_id UUID;
    v_property_id UUID;
    v_unit_id UUID;
    v_expense_id UUID;
BEGIN
    -- Get a single tenant
    SELECT id INTO v_tenant_id FROM public.tenants LIMIT 1;
    
    -- Get a single lease
    SELECT id, property_id INTO v_lease_id, v_property_id FROM public.leases LIMIT 1;
    
    -- Get a single unit from the same property
    SELECT id INTO v_unit_id FROM public.units WHERE property_id = v_property_id LIMIT 1;
    
    -- Get an expense matching that unit
    SELECT id INTO v_expense_id FROM public.expenses WHERE unit_id = v_unit_id LIMIT 1;
    
    -- Now update them
    UPDATE public.leases SET tenant_id = v_tenant_id WHERE id = v_lease_id;
    UPDATE public.units SET tenant_id = v_tenant_id, lease_id = v_lease_id WHERE id = v_unit_id;
    UPDATE public.expenses SET lease_id = v_lease_id, tenant_id = v_tenant_id WHERE id = v_expense_id;
END $$;
