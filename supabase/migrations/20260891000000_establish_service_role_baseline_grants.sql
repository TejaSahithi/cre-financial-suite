-- ===========================================================================
-- Workstream B.1 (migration-history resolution) finding, 2026-08-03: a
-- genuine `supabase db reset --local` (full replay from an empty database
-- through every migration in order) revealed that service_role, anon, AND
-- authenticated all have NO baseline table privileges on virtually any
-- table in the public schema -- confirmed repo-wide via
-- has_table_privilege(), affecting old tables (organizations, leases,
-- properties) exactly as much as new CAM Engine V2 tables. No migration in
-- this repository's history ever REVOKEs these -- they were simply never
-- GRANTed by any migration in the first place. The long-lived local dev
-- database (and, presumably, every other environment) has been working
-- only because SOME one-off, undocumented, out-of-migration setup step
-- established these grants once, outside the tracked history entirely --
-- exactly the class of drift this Workstream exists to close. This is the
-- STANDARD Supabase baseline (normally established by the platform's own
-- init, outside user migrations) -- restoring it here, not inventing a new
-- convention.
--
-- This is safe specifically BECAUSE this repo already relies on RLS, not
-- base grants, as its real enforcement layer throughout (extensive
-- `USING (false)` / `WITH CHECK (false)` lockdown policies on nearly every
-- table, confirmed across the CAM Engine V2 tables and elsewhere) --
-- granting broad TABLE access to anon/authenticated does not widen what
-- either role can actually read or write; RLS policies already restrict
-- that per-table, per-row. What was missing is the base grant Postgres
-- requires before RLS is even consulted, not an RLS gap.
--
-- Deliberately TABLES AND SEQUENCES ONLY -- NOT FUNCTIONS. Unlike tables,
-- Postgres grants EXECUTE on a newly created function to PUBLIC by
-- default; this repo's hundreds of RPC migrations already override that
-- default explicitly per-function
-- (`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;
-- GRANT EXECUTE ... TO service_role;`, used throughout the CAM Engine V2
-- migrations and elsewhere). A blanket `GRANT ALL ON ALL FUNCTIONS` here
-- would risk silently re-opening any function whose own migration's
-- REVOKE was ever incomplete or omitted -- a real privilege-escalation
-- risk this migration must not introduce. Function access stays exactly
-- as each function's own migration already defines it.
--
-- Purely additive (GRANT only, never REVOKE) and idempotent (safe to run
-- against a database that already has these grants via whatever
-- undocumented path established them before). ALTER DEFAULT PRIVILEGES
-- additionally ensures every table created by a FUTURE migration inherits
-- the same baseline automatically, closing this class of gap going
-- forward rather than only for tables that exist today.
-- ===========================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
