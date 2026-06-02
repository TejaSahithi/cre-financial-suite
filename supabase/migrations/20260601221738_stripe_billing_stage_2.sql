-- Add stripe_events table
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now(),
  processing_status TEXT DEFAULT 'processed',
  error_message TEXT
);

-- RLS for stripe_events (locked down, service role only)
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- Add Stripe columns to invoices
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_event_id TEXT REFERENCES public.stripe_events(stripe_event_id),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Add Stripe columns to organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
