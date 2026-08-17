import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20269900000086_sync_cam_inputs_after_expense_edits.sql',
);

describe('expense edit to CAM input sync migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('republishes CAM inputs instead of leaving published copies stale', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_cam_inputs_after_expense_update()');
    expect(sql).toContain("publication_status = 'superseded'");
    expect(sql).toContain("'published'");
    expect(sql).toContain('previous_version_id');
    expect(sql).toContain('source_expense_updated_at');
  });

  it('preserves pool assignments and invalidates existing CAM calculations', () => {
    expect(sql).toContain('INSERT INTO public.cam_input_pool_assignments');
    expect(sql).toContain('round((a.amount / v_published.amount) * v_new_amount, 6)');
    expect(sql).toContain('UPDATE public.cam_runs r');
    expect(sql).toContain('stale = true');
    expect(sql).toContain('public.mark_cam_snapshots_stale');
  });
});
