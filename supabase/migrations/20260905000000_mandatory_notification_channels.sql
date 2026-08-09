-- Require email and SMS delivery attempts for every configured notification event.
-- Provider failures are tracked in notification_deliveries; users cannot mute
-- mandatory workflow delivery through notification_preferences.

ALTER TABLE public.notification_event_permissions
  ADD COLUMN IF NOT EXISTS mandatory_channels TEXT[] NOT NULL DEFAULT ARRAY['email', 'sms']::TEXT[],
  ADD COLUMN IF NOT EXISTS email_required BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_required BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE public.notification_event_permissions
SET mandatory_channels = ARRAY['email', 'sms']::TEXT[],
    email_required = TRUE,
    sms_required = TRUE,
    updated_at = now();
