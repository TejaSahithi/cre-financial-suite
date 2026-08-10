select r.expense_category, r.expense_subcategory, r.expense_category_id::text, c.category_name, c.normalized_key
from public.lease_expense_rules r
left join public.expense_categories c on c.id=r.expense_category_id
where r.org_id = 'b8935ba3-0d07-4336-8d9a-81ce4d3beb9a'
order by r.created_at desc;
