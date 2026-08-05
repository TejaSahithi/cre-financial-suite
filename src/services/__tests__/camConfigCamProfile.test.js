import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveCamProfile, approveCamProfile } from '@/services/camConfig';

/**
 * cam_profiles is RETIRED.
 *
 * These wrappers used to be thin pass-throughs to the save-cam-profile /
 * approve-cam-profile edge functions. The legacy CAM profile model was
 * superseded by materialized recovery policies managed in CAM Setup, and
 * migration 20269900000038 drops the cam_profiles table outright (aborting if
 * it still holds rows).
 *
 * camConfig.js was updated to fail closed — both wrappers now throw before
 * doing anything — but this suite still asserted the old pass-through
 * behaviour, which is why it was failing. It now pins the retirement itself:
 * the contract these tests protect is that NO write path to cam_profiles can
 * be reached from the application, which is precisely the precondition
 * migration 038 depends on.
 */
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('camConfig.saveCamProfile (retired)', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('refuses to write and explains where the behaviour moved to', async () => {
    await expect(saveCamProfile('profile-1', { cam_structure: 'NNN' }))
      .rejects.toThrow(/cam_profiles writes are retired/i);
  });

  it('never reaches the save-cam-profile edge function', async () => {
    await expect(saveCamProfile('profile-1', { cam_structure: 'NNN' })).rejects.toThrow();
    // The critical assertion for migration 038: no runtime caller can touch
    // cam_profiles, so dropping the table cannot break a live code path.
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('refuses regardless of arguments, including a missing profile id', async () => {
    await expect(saveCamProfile(null, { cam_structure: 'NNN' })).rejects.toThrow();
    await expect(saveCamProfile(undefined, undefined)).rejects.toThrow();
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});

describe('camConfig.approveCamProfile (retired)', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('refuses to approve and explains where the behaviour moved to', async () => {
    await expect(approveCamProfile('profile-1'))
      .rejects.toThrow(/cam_profiles approvals are retired/i);
  });

  it('never reaches the approve-cam-profile edge function', async () => {
    await expect(approveCamProfile('profile-1')).rejects.toThrow();
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});
