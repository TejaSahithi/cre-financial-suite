import { useState, useEffect } from 'react';
import { supabase } from '@/services/supabaseClient';
import { ensureOnboardingOrganization } from '@/services/onboardingService';

export function useFirstLoginOrganization({ user, mfaChecked, mfaRequired, refreshProfile }) {
  const [isInitializingOrg, setIsInitializingOrg] = useState(false);
  const [firstLoginAttempted, setFirstLoginAttempted] = useState(false);

  useEffect(() => {
    const hasOrganizationContext = Boolean(
      user?.org_id ||
      user?.activeOrg?.id ||
      user?.memberships?.some((membership) => membership?.org_id)
    );

    if (
      ['approved', 'pending_approval', 'onboarding'].includes(user?.profile?.status) &&
      user?.onboarding_type === 'owner' &&
      !hasOrganizationContext &&
      !isInitializingOrg &&
      !firstLoginAttempted &&
      mfaChecked &&
      !mfaRequired
    ) {
      const initOrg = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          console.warn('[useFirstLoginOrganization] no valid session yet, skipping');
          return;
        }

        setIsInitializingOrg(true);
        setFirstLoginAttempted(true);
        
        try {
          console.log('[useFirstLoginOrganization] Triggering first-login initialization');
          try {
            await ensureOnboardingOrganization();
          } catch (edgeErr) {
            if (edgeErr?.message?.includes('401')) {
              console.warn('[useFirstLoginOrganization] 401 — session not ready');
              return;
            }
            console.warn('[useFirstLoginOrganization] initialization failed:', edgeErr?.message);
          }
          await refreshProfile(false);
        } catch(e) {
          console.error('[useFirstLoginOrganization] First login init error:', e);
        } finally {
          setIsInitializingOrg(false);
        }
      };
      initOrg();
    }
  }, [
    user?.activeOrg?.id, 
    user?.memberships, 
    user?.onboarding_type, 
    user?.org_id, 
    user?.profile?.status, 
    isInitializingOrg, 
    firstLoginAttempted, 
    mfaChecked, 
    mfaRequired, 
    refreshProfile
  ]);

  return { isInitializingOrg };
}
