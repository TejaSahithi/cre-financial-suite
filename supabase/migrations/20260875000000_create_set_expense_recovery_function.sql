-- Migration: 20260875000000_create_set_expense_recovery_function.sql
-- Description: Recreate/define the set_expense_recovery RPC function for modifying expense recovery status and classification.

create or replace function public.set_expense_recovery(
  p_org_id uuid,
  p_expense_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_recovery_status text,
  p_classification text,
  p_approved_status text default null,
  p_rule_source text default 'manual',
  p_recovery_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.expenses%rowtype;
  v_after public.expenses%rowtype;
begin
  if lower(coalesce(p_recovery_status, '')) not in
    ('recoverable', 'non_recoverable', 'conditional', 'excluded', 'needs_review')
  then
    raise exception 'Invalid recovery status';
  end if;

  select * into v_before
    from public.expenses
   where id = p_expense_id and org_id = p_org_id
   for update;

  if not found then
    raise exception 'Expense not found for this organization';
  end if;

  update public.expenses
     set recovery_status = lower(p_recovery_status),
         classification = coalesce(nullif(p_classification, ''), classification),
         approval_status = coalesce(nullif(p_approved_status, ''), approval_status),
         rule_source = coalesce(nullif(p_rule_source, ''), rule_source),
         recovery_reason = coalesce(nullif(p_recovery_reason, ''), recovery_reason),
         updated_at = now()
   where id = p_expense_id and org_id = p_org_id
  returning * into v_after;

  insert into public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata
  ) values (
    p_org_id, v_after.property_id, 'Expense', p_expense_id::text,
    'expense_recovery_updated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_before), to_jsonb(v_after),
    jsonb_build_object('recovery_status', p_recovery_status)
  );

  return jsonb_build_object('row', to_jsonb(v_after), 'expense', to_jsonb(v_after));
end;
$$;

revoke all on function public.set_expense_recovery(
  uuid, uuid, uuid, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.set_expense_recovery(
  uuid, uuid, uuid, text, text, text, text, text, text
) to service_role;

notify pgrst, 'reload schema';
