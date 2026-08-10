select proname, pg_get_function_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname='resolve_expense_category_id';
