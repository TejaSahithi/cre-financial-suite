-- 1. expenses:
SELECT 
    COUNT(*) as total_expenses,
    COUNT(tenant_id) as tenant_id_populated,
    COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_count,
    COUNT(service_period_start) as start_date_populated
FROM public.expenses;

-- 2. expense_classifications:
SELECT 
    COUNT(*) as total_classifications,
    COUNT(row_type) as row_type_populated,
    COUNT(CASE WHEN classification_status = 'finalized' THEN 1 END) as finalized_count,
    COUNT(property_id) as property_id_populated
FROM public.expense_classifications;

-- 3. lease_expense_rules:
SELECT 
    COUNT(*) as total_rules,
    COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_count,
    COUNT(CASE WHEN source_page IS NULL OR source_page = 0 THEN 1 END) as missing_source_page_count,
    COUNT(CASE WHEN exact_source_text IS NULL OR exact_source_text = '' OR LENGTH(exact_source_text) < 15 THEN 1 END) as weak_source_text_count
FROM public.lease_expense_rules;
