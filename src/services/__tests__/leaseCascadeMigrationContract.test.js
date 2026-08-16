import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260878000000_expand_delete_lease_cascade_all_related_data.sql'),
  'utf8',
);
const migrationsDir = resolve(process.cwd(), 'supabase/migrations');

describe('delete_lease_cascade migration contract', () => {
  it('deletes lease-owned enterprise extraction, package, financial, and upload data', () => {
    const requiredTables = [
      'document_enterprise_review_payloads',
      'document_canonical_field_projections',
      'document_intelligence_runs',
      'document_links',
      'lease_claims',
      'lease_document_segments',
      'lease_document_profile_records',
      'lease_document_packages',
      'lease_package_documents',
      'lease_package_membership_decisions',
      'lease_document_relationships',
      'lease_related_document_requirements',
      'lease_package_resolution_runs',
      'lease_package_projection_runs',
      'lease_package_compatibility_writes',
      'lease_date_expressions',
      'lease_date_expression_dependencies',
      'lease_term_candidates',
      'lease_base_rent_schedule_candidates',
      'lease_financial_charge_candidates',
      'lease_financial_calculation_runs',
      'lease_financial_projection_runs',
      'lease_financial_compatibility_writes',
      'portfolio_lease_facts',
      'document_family_members',
      'pipeline_jobs',
      'uploaded_files',
      'documents',
      'budget_line_items',
    ];

    for (const table of requiredTables) {
      expect(migration, `${table} must be covered by the lease cascade`).toContain(table);
    }

    expect(migration).toContain('DELETE FROM public.uploaded_files');
    expect(migration).toContain('UPDATE public.units SET lease_id = NULL');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated');
    expect(migration).not.toContain('GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO authenticated');
    expect(migration).toContain("lease_base_rent_reviewer_decisions', 'org_id = $1 AND (schedule_candidate_id");
    expect(migration).toContain("lease_term_reviewer_decisions', 'org_id = $1 AND (term_candidate_id");
    expect(migration).toContain("lease_date_dependency_reviewer_decisions', 'org_id = $1 AND (dependency_id");
    expect(migration.match(/related_document_requirement_id IN/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(migration).not.toContain("'uploaded_files'\n  ]");
  });

  it('allows immutable result tables to be deleted only inside the lease cascade', () => {
    const bypassedFunctions = [
      'enforce_lease_package_field_projection_immutability',
      'reject_lease_date_expression_link_update',
      'reject_lease_date_expression_review_update',
      'enforce_lease_date_expression_dependency_immutability',
      'reject_lease_date_dependency_review_update',
      'enforce_lease_term_candidate_immutability',
      'reject_lease_term_review_update',
      'enforce_base_rent_candidate_immutability',
      'reject_base_rent_candidate_update',
      'reject_financial_charge_candidate_mutation',
      'reject_lease_financial_calculation_result_mutation',
      'enforce_lease_financial_calculation_run_terminal_immutability',
      'reject_lease_financial_projection_result_mutation',
      'enforce_lease_financial_projection_run_terminal_immutability',
    ];

    expect(migration).toContain("set_config('app.allow_lease_cascade_delete', 'true', true)");

    for (const fn of bypassedFunctions) {
      const start = migration.indexOf(`FUNCTION public.${fn}()`);
      expect(start, `${fn} must be redefined`).toBeGreaterThan(-1);
      const body = migration.slice(start, migration.indexOf('$$;', start) + 3);
      expect(body, `${fn} must only bypass deletes`).toContain("TG_OP = 'DELETE'");
      expect(body, `${fn} must require the cascade GUC`).toContain("current_setting('app.allow_lease_cascade_delete', true) = 'true'");
    }
  });

  it('keeps the final delete_lease_cascade definition free of retired CAM tables', () => {
    const definingMigrations = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => ({
        file,
        sql: readFileSync(resolve(migrationsDir, file), 'utf8'),
      }))
      .filter(({ sql }) => sql.includes('CREATE OR REPLACE FUNCTION public.delete_lease_cascade'));
    const latestDefinition = definingMigrations.at(-1);

    expect(latestDefinition?.file).toBe('20269900000084_fix_delete_lease_cascade_extraction_runs_upload_fk.sql');
    expect(latestDefinition?.sql).not.toContain('cam_tenant_shares');
    expect(latestDefinition?.sql).toContain("to_regclass(format('public.%I', child_table))");
    expect(latestDefinition?.sql).toContain("uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)");
    expect(latestDefinition?.sql).toContain("('extraction_runs', 'org_id = $1 AND (id IN");
  });
});
