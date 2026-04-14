ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL;

ALTER TABLE public.revenues
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL;

ALTER TABLE public.budgets
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'property',
  ADD COLUMN IF NOT EXISTS period TEXT DEFAULT 'annual',
  ADD COLUMN IF NOT EXISTS generation_method TEXT,
  ADD COLUMN IF NOT EXISTS cam_total NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS noi NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_insights TEXT;

CREATE INDEX IF NOT EXISTS idx_expenses_portfolio_scope ON public.expenses(portfolio_id) WHERE portfolio_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_building_scope ON public.expenses(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_unit_scope ON public.expenses(unit_id) WHERE unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_revenues_portfolio_scope ON public.revenues(portfolio_id) WHERE portfolio_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenues_building_scope ON public.revenues(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenues_unit_scope ON public.revenues(unit_id) WHERE unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_budgets_portfolio_scope ON public.budgets(portfolio_id) WHERE portfolio_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_building_scope ON public.budgets(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_unit_scope ON public.budgets(unit_id) WHERE unit_id IS NOT NULL;
