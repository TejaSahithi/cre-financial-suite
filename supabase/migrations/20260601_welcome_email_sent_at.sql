-- Migration: 20260601_welcome_email_sent_at.sql
-- Description: Adds a one-time sentinel column to organizations to prevent
--              duplicate Welcome Aboard emails when approve-organization fires.
--
-- NULL  = email not yet sent.
-- Non-null = timestamp when the welcome email was successfully delivered.
--
-- This column is only written by the approve-organization edge function via
-- the service role key — never from the frontend.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ DEFAULT NULL;
