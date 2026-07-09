-- Enterprise hardening Phase 6R-5: lease-expense-rule family RLS policy-shape
-- repair. Parity/structure repair only -- NOT hard lockdown. No policy in
-- this migration is set to false; every canonical policy below preserves
-- (or, where explicitly directed, narrows to an already-existing alternate
-- grant) the effective read/write permission that already exists today.
--
-- Confirmed via Phase 6R-3's fresh inventory (re-verified this phase):
-- zero live app write call sites remain for any of the 4 tables below
-- (save_lease_expense_rule_set / update_lease_expense_rule_set_status /
-- update_lease_expense_rule / update_lease_expense_rule_amount own every
-- live write path, all SECURITY DEFINER + service_role-only, which
-- bypasses RLS entirely and is therefore unaffected by anything in this
-- migration). The only client-session direct writes left are (a) dead code
-- in leaseAbstractService.js (zero live callers) and (b)
-- leaseService.js::deleteLeaseCascadeFallback's rare fallback-tier direct
-- DELETE (fires only when delete_lease_cascade RPC is unavailable).
--
-- Drift found (local vs. remote, both confirmed via direct policy
-- inspection):
--   - lease_expense_rule_sets / lease_expense_rules: local carries BOTH the
--     original per-command policies (from 20260424000000_expense_classifications.sql
--     + 20260522000004_add_lease_expense_rules_delete_policy.sql) AND a
--     later FOR-ALL "_org_write"/"_org_select" pair
--     (20260524000000_fix_lease_expense_rls_property_access.sql) that was
--     never meant to replace them but never dropped them either --
--     redundant, overlapping write authorization on local. Remote is
--     missing the original per-command policies entirely (untracked --
--     they were apparently never applied there), so remote's only
--     authorization today is the org_write/org_select pair.
--   - lease_expense_values / lease_expense_rule_clauses: local has only the
--     original per-command policies (no org_write/org_select -- that
--     migration never touched these two tables). Remote instead has an
--     org_select/org_write pair for BOTH tables that **no migration in this
--     repo creates** -- confirmed via repo-wide grep, zero matches -- pure
--     untracked drift, the same class of manual/pre-migration-history
--     change already found for audit_logs.user_id, budgets_all, and
--     get_my_org_ids(). This drift is not just cosmetic: remote's org_write
--     (FOR ALL) grants direct UPDATE/DELETE on these two tables that
--     local's tracked policies never allowed (local has no DELETE policy
--     for lease_expense_values at all, and no UPDATE/DELETE policy at all
--     for lease_expense_rule_clauses).
--
-- Decision (per explicit instruction): local's tracked behavior is the
-- source of truth for lease_expense_values/lease_expense_rule_clauses.
-- Confirmed no live app path requires remote's extra permissiveness --
-- every real write already goes through the RPCs above (service_role,
-- unaffected by any of this), and the only client-session path touching
-- these tables is the rare cascade-delete fallback, which itself only
-- deletes lease_expense_rule_clauses (not lease_expense_values -- that
-- table isn't in deleteLeaseCascadeFallback's table list at all, a
-- separate, already-flagged pre-existing gap, untouched here). No stop
-- condition was hit; proceeding without pausing for confirmation, per the
-- task's own "if NOT necessary, proceed" framing.
--
-- Canonical shape per table (SELECT kept portable and behavior-preserving;
-- WRITE consolidated onto the already-existing, already-portable
-- can_write_org_data(org_id)-based policies per the task's explicit
-- direction -- can_write_org_data() already internally includes
-- is_super_admin(), so "is_super_admin() OR can_write_org_data(org_id)"
-- and plain "can_write_org_data(org_id)" are equivalent; the shorter form
-- already used by every existing per-command write policy is kept):
--
--   lease_expense_rule_sets:
--     _select   -> is_member_of_org(org_id) OR (property_id IS NULL OR can_access_property(property_id))
--                  (exact behavior of the current _org_select policy,
--                  ported to the portable helper -- subsumes the plain
--                  _select and _select_super_admin policies, which add
--                  nothing beyond this)
--     _insert   -> can_write_org_data(org_id)                    [unchanged]
--     _update   -> can_write_org_data(org_id)                    [unchanged]
--     _delete   -> can_write_org_data(org_id)                    [NEW -- see below]
--     dropped: _org_select, _org_write
--
--   lease_expense_rules:
--     _select   -> is_member_of_org(org_id) OR rule_set_id IN (rule_sets
--                  matching is_member_of_org(org_id) OR property fallback)
--                  (exact behavior of the current _org_select policy)
--     _insert   -> unchanged (via rule_set's can_write_org_data)
--     _update   -> unchanged (via rule_set's can_write_org_data)
--     _delete   -> unchanged (can_write_org_data(org_id) directly)
--     dropped: _org_select, _org_write
--
--   lease_expense_values:
--     _select   -> rewritten to use is_member_of_org (portable), same join
--                  shape as today, otherwise unchanged
--     _insert   -> unchanged
--     _update   -> unchanged
--     _delete   -> none (matches local's current tracked absence -- see
--                  decision above)
--     dropped: _org_select, _org_write (remote-only, untracked)
--
--   lease_expense_rule_clauses:
--     _select   -> rewritten to use is_member_of_org (portable), same join
--                  shape as today, otherwise unchanged
--     _insert   -> unchanged
--     _update / _delete -> none (matches local's current tracked absence)
--     dropped: _org_select, _org_write (remote-only, untracked)
--
-- Why lease_expense_rule_sets gains a NEW _delete policy: dropping
-- _org_write there removes its ONLY delete coverage (no dedicated _delete
-- policy has ever existed for this table). Dropping it with no replacement
-- would silently lock DELETE to deny-all -- exactly the kind of
-- unannounced lockdown this phase is explicitly barred from doing. Adding
-- a _delete policy with the same can_write_org_data(org_id) shape as its
-- sibling _update preserves today's effective delete permission instead
-- of silently removing it.
--
-- _select_super_admin policies (added generically across ~27 tables by
-- 20260601000000_superadmin_platform_reads.sql, covering
-- lease_expense_rule_sets/lease_expense_rules/lease_expense_values but not
-- lease_expense_rule_clauses) are left completely untouched -- out of
-- scope for this table-specific repair, and already fully subsumed by the
-- new _select policies above (harmless redundancy, not a lockdown risk
-- since it's SELECT-only).

-- ── lease_expense_rule_sets ──────────────────────────────────────────────
DROP POLICY IF EXISTS "lease_expense_rule_sets_org_select" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_org_write" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_select" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_insert" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_update" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_delete" ON public.lease_expense_rule_sets;

CREATE POLICY "lease_expense_rule_sets_select" ON public.lease_expense_rule_sets
  FOR SELECT USING (
    public.is_member_of_org(org_id)
    OR ((property_id IS NULL) OR public.can_access_property(property_id))
  );
CREATE POLICY "lease_expense_rule_sets_insert" ON public.lease_expense_rule_sets
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "lease_expense_rule_sets_update" ON public.lease_expense_rule_sets
  FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "lease_expense_rule_sets_delete" ON public.lease_expense_rule_sets
  FOR DELETE USING (public.can_write_org_data(org_id));

-- ── lease_expense_rules ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "lease_expense_rules_org_select" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_org_write" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_select" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_insert" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_update" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_delete" ON public.lease_expense_rules;

CREATE POLICY "lease_expense_rules_select" ON public.lease_expense_rules
  FOR SELECT USING (
    public.is_member_of_org(org_id)
    OR rule_set_id IN (
      SELECT s.id FROM public.lease_expense_rule_sets s
      WHERE public.is_member_of_org(s.org_id)
         OR ((s.property_id IS NULL) OR public.can_access_property(s.property_id))
    )
  );
CREATE POLICY "lease_expense_rules_insert" ON public.lease_expense_rules
  FOR INSERT WITH CHECK (
    rule_set_id IN (
      SELECT lease_expense_rule_sets.id FROM public.lease_expense_rule_sets
      WHERE public.can_write_org_data(lease_expense_rule_sets.org_id)
    )
  );
CREATE POLICY "lease_expense_rules_update" ON public.lease_expense_rules
  FOR UPDATE USING (
    rule_set_id IN (
      SELECT lease_expense_rule_sets.id FROM public.lease_expense_rule_sets
      WHERE public.can_write_org_data(lease_expense_rule_sets.org_id)
    )
  );
CREATE POLICY "lease_expense_rules_delete" ON public.lease_expense_rules
  FOR DELETE USING (public.can_write_org_data(org_id));

-- ── lease_expense_values ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "lease_expense_values_org_select" ON public.lease_expense_values;
DROP POLICY IF EXISTS "lease_expense_values_org_write" ON public.lease_expense_values;
DROP POLICY IF EXISTS "lease_expense_values_select" ON public.lease_expense_values;
DROP POLICY IF EXISTS "lease_expense_values_insert" ON public.lease_expense_values;
DROP POLICY IF EXISTS "lease_expense_values_update" ON public.lease_expense_values;

CREATE POLICY "lease_expense_values_select" ON public.lease_expense_values
  FOR SELECT USING (
    rule_id IN (
      SELECT lease_expense_rules.id FROM public.lease_expense_rules
      WHERE lease_expense_rules.rule_set_id IN (
        SELECT lease_expense_rule_sets.id FROM public.lease_expense_rule_sets
        WHERE public.is_member_of_org(lease_expense_rule_sets.org_id)
      )
    )
  );
CREATE POLICY "lease_expense_values_insert" ON public.lease_expense_values
  FOR INSERT WITH CHECK (
    rule_id IN (
      SELECT lease_expense_rules.id FROM public.lease_expense_rules
      WHERE lease_expense_rules.rule_set_id IN (
        SELECT lease_expense_rule_sets.id FROM public.lease_expense_rule_sets
        WHERE public.can_write_org_data(lease_expense_rule_sets.org_id)
      )
    )
  );
CREATE POLICY "lease_expense_values_update" ON public.lease_expense_values
  FOR UPDATE USING (
    rule_id IN (
      SELECT lease_expense_rules.id FROM public.lease_expense_rules
      WHERE lease_expense_rules.rule_set_id IN (
        SELECT lease_expense_rule_sets.id FROM public.lease_expense_rule_sets
        WHERE public.can_write_org_data(lease_expense_rule_sets.org_id)
      )
    )
  );

-- ── lease_expense_rule_clauses ───────────────────────────────────────────
DROP POLICY IF EXISTS "lease_expense_rule_clauses_org_select" ON public.lease_expense_rule_clauses;
DROP POLICY IF EXISTS "lease_expense_rule_clauses_org_write" ON public.lease_expense_rule_clauses;
DROP POLICY IF EXISTS "lease_expense_rule_clauses_select" ON public.lease_expense_rule_clauses;
DROP POLICY IF EXISTS "lease_expense_rule_clauses_insert" ON public.lease_expense_rule_clauses;

CREATE POLICY "lease_expense_rule_clauses_select" ON public.lease_expense_rule_clauses
  FOR SELECT USING (
    lease_id IN (
      SELECT leases.id FROM public.leases
      WHERE public.is_member_of_org(leases.org_id)
    )
  );
CREATE POLICY "lease_expense_rule_clauses_insert" ON public.lease_expense_rule_clauses
  FOR INSERT WITH CHECK (
    lease_id IN (
      SELECT leases.id FROM public.leases
      WHERE public.can_write_org_data(leases.org_id)
    )
  );
