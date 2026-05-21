-- 1. leases.tenant_id count
SELECT COUNT(tenant_id) as lease_tenant_id_count FROM public.leases;

-- 2. units.tenant_id count
SELECT COUNT(tenant_id) as unit_tenant_id_count FROM public.units;

-- 3. expenses.lease_id count
SELECT COUNT(lease_id) as expense_lease_id_count FROM public.expenses;

-- 4. expenses.unit_id count
SELECT COUNT(unit_id) as expense_unit_id_count FROM public.expenses;

-- 5. active lease match by property/building/unit/date count
SELECT COUNT(*) as active_lease_match
FROM public.leases l
JOIN public.expenses e ON 
  (l.property_id = e.property_id OR l.building_id = e.building_id OR l.unit_id = e.unit_id)
  AND (l.start_date <= e.date OR l.start_date <= e.service_period_start)
  AND (l.end_date >= e.date OR l.end_date >= e.service_period_end);
