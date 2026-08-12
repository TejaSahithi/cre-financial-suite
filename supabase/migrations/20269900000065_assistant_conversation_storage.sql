-- ============================================================
-- Assistant V1 — conversation storage (read-only AI Assistant, section 24)
--
-- Three tables: assistant_conversations, assistant_messages,
-- assistant_tool_runs. All writes happen exclusively through the
-- assistant-chat-v1 edge function running as service_role (which bypasses
-- RLS), matching the write-lockdown pattern already used for expenses/leases
-- (see 20260804000000_expenses_rls_lockdown.sql) -- RLS here only needs to
-- grant SELECT, and only to the owning user. No INSERT/UPDATE/DELETE policy
-- is defined for `authenticated`, so RLS denies those by default for
-- non-service-role callers.
--
-- Conversations are private per-user (not shared org-wide): a user's
-- Assistant chat may reference resources they specifically asked about, and
-- another member of the same org should not be able to browse it. Uses
-- is_member_of_org() (not get_my_org_ids(), which has a known local/remote
-- return-type divergence -- see 20260874000000_update_expenses_and_audit_logs.sql)
-- combined with an explicit user_id = auth.uid() check.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.assistant_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  acting_org_id   UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_conversations_user_idx
  ON public.assistant_conversations (org_id, acting_org_id, user_id, updated_at DESC);

ALTER TABLE public.assistant_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assistant_conversations_select_own" ON public.assistant_conversations
  FOR SELECT
  USING (user_id = auth.uid() AND public.is_member_of_org(org_id));

CREATE TABLE IF NOT EXISTS public.assistant_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES public.assistant_conversations(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  acting_org_id     UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id           UUID NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT NOT NULL,
  response_status   TEXT CHECK (
    response_status IS NULL OR response_status IN (
      'answered', 'access_denied', 'no_data', 'insufficient_evidence', 'unsupported', 'error'
    )
  ),
  -- Sanitized, small: {page, route, entities:{...ids only}}. Never full page
  -- state or record datasets (section 18) -- enforced by the edge function,
  -- not by this column, but kept TEXT-length-limited-in-practice by callers.
  ui_context        JSONB NOT NULL DEFAULT '{}'::jsonb,
  citations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  navigation        JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_messages_conversation_idx
  ON public.assistant_messages (conversation_id, org_id, acting_org_id, user_id, created_at);

ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assistant_messages_select_own" ON public.assistant_messages
  FOR SELECT
  USING (user_id = auth.uid() AND public.is_member_of_org(org_id));

CREATE TABLE IF NOT EXISTS public.assistant_tool_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID NOT NULL REFERENCES public.assistant_messages(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  acting_org_id     UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id           UUID NOT NULL,
  tool_name         TEXT NOT NULL,
  arguments         JSONB NOT NULL DEFAULT '{}'::jsonb,
  authorized        BOOLEAN NOT NULL,
  denial_reason     TEXT,
  -- Compact result metadata only (row counts, ids referenced) -- never the
  -- full tool payload or raw financial/lease data (section 25: avoid
  -- unnecessarily logging entire confidential lease clauses or datasets).
  result_summary    JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_tool_runs_message_idx
  ON public.assistant_tool_runs (message_id, org_id, acting_org_id, user_id);

ALTER TABLE public.assistant_tool_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assistant_tool_runs_select_own" ON public.assistant_tool_runs
  FOR SELECT
  USING (user_id = auth.uid() AND public.is_member_of_org(org_id));
