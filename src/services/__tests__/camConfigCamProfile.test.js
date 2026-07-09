import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveCamProfile, approveCamProfile } from '@/services/camConfig';

// Feature: enterprise-readiness-hardening Phase 6CAM-1 (save_cam_profile /
// approve_cam_profile). These wrappers are thin pass-throughs to their edge
// functions -- the real validation/idempotency/audit behavior is covered by
// supabase/functions/_tests/cam-profile-workflows.property.test.ts. These
// tests only prove the frontend call sites send the right shape and no
// longer perform any direct supabase.from("cam_profiles").update() write.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('camConfig.saveCamProfile', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('calls save-cam-profile with the profile id and patch', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      changed: true,
      profile: { id: 'profile-1', cam_structure: 'NNN' },
      audit_log_id: 'audit-1',
    });

    const result = await saveCamProfile('profile-1', { cam_structure: 'NNN', admin_fee_percent: 5 });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('save-cam-profile', {
      profile_id: 'profile-1',
      patch: { cam_structure: 'NNN', admin_fee_percent: 5 },
    });
    expect(result.id).toBe('profile-1');
    expect(result.cam_structure).toBe('NNN');
  });

  it('rejects a missing profile id without calling the edge function', async () => {
    await expect(saveCamProfile(null, { cam_structure: 'NNN' })).rejects.toThrow('CAM profile ID is required');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('returns null when the edge function reports no profile', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ error: false, changed: false, profile: null });
    const result = await saveCamProfile('profile-2', {});
    expect(result).toBeNull();
  });
});

describe('camConfig.approveCamProfile', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('calls approve-cam-profile with the profile id', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      changed: true,
      profile: { id: 'profile-1', status: 'approved', approved_by: 'reviewer@example.test' },
      audit_log_id: 'audit-2',
    });

    const result = await approveCamProfile('profile-1');

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('approve-cam-profile', {
      profile_id: 'profile-1',
    });
    expect(result.status).toBe('approved');
    expect(result.approved_by).toBe('reviewer@example.test');
  });

  it('rejects a missing profile id without calling the edge function', async () => {
    await expect(approveCamProfile(undefined)).rejects.toThrow('CAM profile ID is required');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});
