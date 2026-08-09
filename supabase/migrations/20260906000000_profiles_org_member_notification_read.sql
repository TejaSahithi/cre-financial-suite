-- Allow notification recipient resolution to read profile contact details for active users in the same org.
-- Without this policy, org admins/managers can create notifications but cannot resolve recipient emails.

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_self_or_org_members'
  ) then
    create policy profiles_select_self_or_org_members
      on public.profiles
      for select
      using (
        id = auth.uid()
        or is_super_admin()
        or exists (
          select 1
          from public.memberships requester
          join public.memberships target
            on target.org_id = requester.org_id
          where requester.user_id = auth.uid()
            and requester.status = 'active'
            and target.user_id = profiles.id
            and target.status = 'active'
        )
      );
  end if;
end $$;
