import { useState, useEffect } from 'react';
import { supabase } from '@/services/supabaseClient';

export function useMfaStatus({ isAuthenticated, user, refreshProfile }) {
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaChecked, setMfaChecked] = useState(false);
  const [mfaNeedsEnroll, setMfaNeedsEnroll] = useState(false);
  const [mfaVerifiedThisSession, setMfaVerifiedThisSession] = useState(false);

  useEffect(() => {
    const checkMFA = async () => {
      if (!isAuthenticated) {
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
        setMfaChecked(true);
        return;
      }

      if (mfaVerifiedThisSession) {
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
        setMfaChecked(true);
        return;
      }

      try {
        const { data: { session } } = await supabase.auth.getSession();
        const provider = session?.user?.app_metadata?.provider || 'email';

        const isOAuthProvider = provider === 'google' || provider === 'azure';
        if (isOAuthProvider) {
          const rawRole = user?._raw_role || user?.role || '';
          const requiresMfaByRole = ['super_admin', 'org_admin', 'admin', 'manager'].includes(rawRole);
          if (!requiresMfaByRole) {
            setMfaRequired(false);
            setMfaNeedsEnroll(false);
            setMfaChecked(true);
            return;
          }
        }

        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        const currentLevel = data?.currentLevel;
        const nextLevel = data?.nextLevel;

        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const totpFactors = (factorsData?.totp || []);
        const verifiedFactors = totpFactors.filter(f => f.status === 'verified');

        if (totpFactors.length === 0) {
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else if (verifiedFactors.length > 0 && currentLevel === 'aal1' && nextLevel === 'aal2') {
          setMfaNeedsEnroll(false);
          setMfaRequired(true);
        } else if (verifiedFactors.length === 0 && totpFactors.length > 0) {
          setMfaNeedsEnroll(true);
          setMfaRequired(true);
        } else {
          setMfaRequired(false);
          setMfaNeedsEnroll(false);
        }
      } catch(e) {
        console.warn('[useMfaStatus] MFA check error:', e);
        setMfaRequired(false);
        setMfaNeedsEnroll(false);
      }
      setMfaChecked(true);
    };
    checkMFA();
  }, [isAuthenticated, user?.id, mfaVerifiedThisSession, user?._raw_role, user?.role]);

  const handleMfaVerified = async () => {
    setMfaVerifiedThisSession(true);
    setMfaRequired(false);
    setMfaNeedsEnroll(false);
    setMfaChecked(true);
    await refreshProfile(false);
  };

  return {
    mfaRequired,
    mfaChecked,
    mfaNeedsEnroll,
    handleMfaVerified
  };
}
