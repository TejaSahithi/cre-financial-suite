-- Add DELETE policy for lease_expense_rules

CREATE POLICY "lease_expense_rules_delete" ON public.lease_expense_rules FOR DELETE USING (
  public.can_write_org_data(org_id)
);
