-- Lease Expense Rules V1 source-of-truth hardening.
-- Fallback/TypeScript keyword-generated rows are not authoritative contract rules.
-- They must not be approved, published, or used as recovery-policy inputs.

update public.lease_expense_rules
set
  review_status = 'needs_review',
  approval_status = 'draft',
  published_to_cam = false,
  row_status = case
    when coalesce(row_status, '') = 'superseded' then row_status
    else 'needs_review'
  end,
  notes = trim(both ' ' from concat_ws(' ', notes, 'System note: fallback-generated lease expense semantics disabled; re-extract from the lease document and approve the contractual rule explicitly.'))
where
  coalesce(generation_source, '') ilike '%fallback%'
  or coalesce(generation_source, '') ilike 'typescript_schema%'
  or coalesce(extraction_status, '') in ('inferred', 'missing_source_evidence');

update public.lease_expense_rule_sets rs
set status = 'draft'
where exists (
  select 1
  from public.lease_expense_rules r
  where r.rule_set_id = rs.id
    and (
      coalesce(r.generation_source, '') ilike '%fallback%'
      or coalesce(r.generation_source, '') ilike 'typescript_schema%'
      or coalesce(r.extraction_status, '') in ('inferred', 'missing_source_evidence')
    )
);