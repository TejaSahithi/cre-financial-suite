import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('expense direct_tenant_ids migration contract', () => {
  it('normalizes direct_tenant_ids to uuid[] before expense detail edits run', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20269900000085_repair_expense_direct_tenant_ids_uuid_array.sql'),
      'utf8',
    );

    expect(migration).toContain('ALTER COLUMN direct_tenant_ids TYPE UUID[]');
    expect(migration).toContain('direct_tenant_ids::TEXT[]');
    expect(migration).toContain('_coerce_text_array_to_uuid_array');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public._coerce_text_array_to_uuid_array(TEXT[])');
  });
});
