select id::text, org_id::text, category_name, subcategory_name, normalized_key
from public.expense_categories
where org_id is null or org_id = 'b8935ba3-0d07-4336-8d9a-81ce4d3beb9a'
order by coalesce(display_order, 9999), category_name, subcategory_name
limit 200;
