with labels(label) as (values
  ('Premises Property Tax'),('Landlord Property Policy'),('Resurfacing'),('Tenant Service Contract'),('Electricity and Water'),('Tenant-Caused Damage'),('Legal Review'),
  ('Utilities - Electric'),('Janitorial'),('Repairs & Maintenance'),('Landscaping'),('Tenant Improvement'),('Security'),('Insurance')
)
select label, public.resolve_expense_category_id('b8935ba3-0d07-4336-8d9a-81ce4d3beb9a', label) as resolved
from labels;
