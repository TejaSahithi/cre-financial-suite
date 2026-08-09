-- Revert org-member profile read access.
-- This restores the previous profiles RLS behavior after the policy caused platform issues.

drop policy if exists profiles_select_self_or_org_members on public.profiles;
