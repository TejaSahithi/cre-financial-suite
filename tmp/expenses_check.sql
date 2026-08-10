select id::text, date, vendor, category, expense_subcategory, expense_category_id::text, gl_code, allocation_type, allocation_meta, classification, recovery_status, approval_status, review_status
from public.expenses
where org_id = 'b8935ba3-0d07-4336-8d9a-81ce4d3beb9a'
  and property_id is not null
order by created_at desc, date
limit 30;
