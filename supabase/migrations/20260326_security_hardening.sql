-- ============================================================
-- CRE Financial Suite — Security Hardening Migration
-- Ensures secure state by cleaning up any lingering insecure
-- policies on critical tables like notifications and audit logs.
-- NOTE: The primary fixes for memberships, organizations, and
-- asset tables have been integrated into the core schema files.
-- Date: 2026-03-26
-- ============================================================


-- ============================================================
-- FIX 4: NOTIFICATIONS — Add INSERT policy
-- 
-- Notifications table had SELECT and UPDATE but no INSERT
-- policy for regular users, only SECURITY DEFINER triggers
-- could insert. This is correct but let's make it explicit.
-- ============================================================

-- Only allow system (SECURITY DEFINER triggers) to insert notifications
-- Regular users should not be able to create arbitrary notifications
DROP POLICY IF EXISTS "notifications_insert_system" ON public.notifications;
-- No user-facing INSERT policy needed — triggers use SECURITY DEFINER


-- ============================================================
-- FIX 5: AUDIT LOGS — Prevent user tampering
--
-- Audit logs should be append-only from triggers.
-- No user should be able to UPDATE or DELETE audit records.
-- ============================================================

-- Explicitly deny update/delete (no policies = denied by default with RLS enabled)
-- The existing SELECT policy is already admin-only, which is correct.
-- Just ensure no ALL/UPDATE/DELETE policies exist:
DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_update" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_delete" ON public.audit_logs;
