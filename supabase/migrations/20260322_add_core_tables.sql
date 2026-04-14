-- ============================================================
-- CRE Financial Suite — Core Schema Extension
-- Migrated from Base44 to Native Supabase Triggers
-- ============================================================

-- 1. NOTIFICATIONS
CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- lease_expiry | budget_approval | cam_variance | system
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  link        TEXT,
  priority    TEXT DEFAULT 'medium', -- low | medium | high
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_select_own" ON public.notifications FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE USING (org_id IN (SELECT public.get_my_org_ids()));

-- 2. AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  action          TEXT NOT NULL, -- create | update | delete | upload | approve | lock
  field_changed   TEXT,
  old_value       TEXT,
  new_value       TEXT,
  user_email      TEXT,
  user_name       TEXT,
  property_name   TEXT,
  building_name   TEXT,
  unit_number     TEXT,
  ip_address      TEXT,
  property_id     UUID,
  timestamp       TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_select_admin" ON public.audit_logs FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

-- 3. PROPERTIES & PORTFOLIOS
CREATE TABLE IF NOT EXISTS public.portfolios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id    UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  property_type   TEXT,
  total_sqft      NUMERIC,
  year_built      INT,
  status          TEXT DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 4. BUILDINGS & UNITS
CREATE TABLE IF NOT EXISTS public.buildings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name            TEXT,
  total_sqft      NUMERIC,
  floors          INT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.units (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id     UUID REFERENCES public.buildings(id) ON DELETE CASCADE,
  unit_number     TEXT NOT NULL,
  square_footage  NUMERIC,
  status          TEXT DEFAULT 'vacant',
  tenant_id       UUID, -- Link to tenants table later
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 5. LEASES & TENANTS
CREATE TABLE IF NOT EXISTS public.tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  company     TEXT,
  status      TEXT DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  unit_id         UUID REFERENCES public.units(id) ON DELETE SET NULL,
  tenant_name     TEXT,
  tenant_id       UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  start_date      DATE,
  end_date        DATE,
  monthly_rent    NUMERIC DEFAULT 0,
  square_footage  NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'active', -- active | expired | drafted | budget_ready
  lease_type      TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 6. EXPENSES & BUDGETS
CREATE TABLE IF NOT EXISTS public.expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  category        TEXT,
  amount          NUMERIC DEFAULT 0,
  classification  TEXT, -- recoverable | non_recoverable | conditional
  vendor          TEXT,
  vendor_id       UUID,
  gl_code         TEXT,
  fiscal_year     INT,
  month           INT,
  date            DATE,
  source          TEXT,
  is_controllable BOOLEAN DEFAULT TRUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.budgets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  budget_year     INT NOT NULL,
  total_revenue   NUMERIC DEFAULT 0,
  total_expenses  NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'draft', -- draft | under_review | approved | locked
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 7. OTHER TABLES
CREATE TABLE IF NOT EXISTS public.vendors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  category    TEXT,
  status      TEXT DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  amount          NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'pending', -- pending | paid | overdue
  due_date        DATE,
  issued_date     DATE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS FOR ALL TABLES (Granular Policies)
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
      'portfolios', 'properties', 'buildings', 'units',
      'tenants', 'leases', 'expenses', 'budgets',
      'vendors', 'invoices'
    ])
    LOOP
        -- Enable RLS
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

        -- Drop old/potentially insecure policies
        EXECUTE format('DROP POLICY IF EXISTS "%s_all" ON public.%I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

        -- SELECT policy: any org member can read
        EXECUTE format(
          'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()))',
          t, t
        );

        -- INSERT policy: only users with write permissions
        EXECUTE format(
          'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
          t, t
        );

        -- UPDATE policy: only users with write permissions
        EXECUTE format(
          'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
          t, t
        );

        -- DELETE policy: only org admins or super admins
        EXECUTE format(
          'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
          t, t
        );
    END LOOP;
END $$;

-- ============================================================
-- BUSINESS LOGIC TRIGGERS (Migration from Base44)
-- ============================================================

-- 1. LEASE EXPIRY & STATUS TRANSITION
CREATE OR REPLACE FUNCTION public.fn_on_lease_changed()
RETURNS TRIGGER AS $$
DECLARE
    days_left INT;
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value, user_email)
    VALUES (NEW.org_id, 'Lease', NEW.id::text, 
            CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END,
            COALESCE(NEW.created_by, 'system'));

    -- Expiry Notification (within 180 days)
    IF NEW.end_date IS NOT NULL THEN
        days_left := NEW.end_date - CURRENT_DATE;
        IF days_left > 0 AND days_left <= 180 THEN
            -- Only create if not exists for this lease
            IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE type = 'lease_expiry' AND link = NEW.id::text AND is_read = FALSE) THEN
                INSERT INTO public.notifications (org_id, type, title, message, link, priority)
                VALUES (NEW.org_id, 'lease_expiry', 'Lease Expiration Alert', 
                        format('%s''s lease expires in %s days (%s). Review renewal options.', NEW.tenant_name, days_left, NEW.end_date),
                        NEW.id::text,
                        CASE WHEN days_left <= 90 THEN 'high' ELSE 'medium' END);
            END IF;
        END IF;
    END IF;

    -- Budget Ready Notification
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'budget_ready' THEN
        INSERT INTO public.notifications (org_id, type, title, message, priority)
        VALUES (NEW.org_id, 'budget_approval', 'Lease Ready for Budget',
                format('%s''s lease has been validated and is now budget-ready.', NEW.tenant_name),
                'medium');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_lease_changed ON public.leases;
CREATE TRIGGER tr_lease_changed AFTER INSERT OR UPDATE ON public.leases FOR EACH ROW EXECUTE FUNCTION public.fn_on_lease_changed();


-- 2. EXPENSE VARIANCE ALERT
CREATE OR REPLACE FUNCTION public.fn_on_expense_added()
RETURNS TRIGGER AS $$
DECLARE
    total_actual NUMERIC;
    total_budgeted NUMERIC;
    variance_pct NUMERIC;
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, property_id, user_email)
    VALUES (NEW.org_id, 'Expense', NEW.id::text, 'create', NEW.property_id, COALESCE(NEW.created_by, 'system'));

    -- Recalculate Variance for this property and year
    IF NEW.property_id IS NOT NULL AND NEW.fiscal_year IS NOT NULL THEN
        SELECT SUM(amount) INTO total_actual FROM public.expenses WHERE property_id = NEW.property_id AND fiscal_year = NEW.fiscal_year;
        SELECT SUM(total_expenses) INTO total_budgeted FROM public.budgets WHERE property_id = NEW.property_id AND budget_year = NEW.fiscal_year;

        IF total_budgeted > 0 THEN
            variance_pct := ((total_actual - total_budgeted) / total_budgeted) * 100;
            
            IF ABS(variance_pct) > 10 THEN
                INSERT INTO public.notifications (org_id, type, title, message, priority)
                VALUES (NEW.org_id, 'cam_variance', 'Expense Variance Alert',
                        format('Total actual expenses ($%s) now %s%% %s budget ($%s) for FY %s.', 
                               ROUND(total_actual, 2), ROUND(ABS(variance_pct), 1), 
                               CASE WHEN variance_pct > 0 THEN 'over' ELSE 'under' END,
                               ROUND(total_budgeted, 2), NEW.fiscal_year),
                        CASE WHEN ABS(variance_pct) > 20 THEN 'high' ELSE 'medium' END);
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_expense_added ON public.expenses;
CREATE TRIGGER tr_expense_added AFTER INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.fn_on_expense_added();


-- 3. BUDGET STATUS TRANSITIONS
CREATE OR REPLACE FUNCTION public.fn_on_budget_changed()
RETURNS TRIGGER AS $$
BEGIN
    -- Audit Log
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, old_value, new_value)
    VALUES (NEW.org_id, 'Budget', NEW.id::text, 
            CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN OLD.status ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.status ELSE NULL END);

    -- Notifications on state change
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
        IF NEW.status = 'approved' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Approved', format('Budget "%s" (FY %s) has been approved.', NEW.name, NEW.budget_year), 'medium');
        ELSIF NEW.status = 'locked' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Locked', format('Budget "%s" (FY %s) is now locked.', NEW.name, NEW.budget_year), 'low');
        ELSIF NEW.status = 'under_review' THEN
            INSERT INTO public.notifications (org_id, type, title, message, priority)
            VALUES (NEW.org_id, 'budget_approval', 'Budget Submitted', format('Budget "%s" (FY %s) has been submitted for review.', NEW.name, NEW.budget_year), 'medium');
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_budget_changed ON public.budgets;
CREATE TRIGGER tr_budget_changed AFTER INSERT OR UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.fn_on_budget_changed();
