/**
 * Shared Supabase Client — true singleton across module re-evaluations.
 *
 * Vite HMR and React Strict Mode can re-evaluate ES modules in dev,
 * creating a second `createClient` call and a second auth client that
 * races on the @supabase/gotrue-js auth-token lock. Caching the
 * instance on `globalThis` guarantees one client per browser context
 * regardless of how many times this module is loaded. In production
 * there is no HMR and no Strict Mode, so the cache is a no-op.
 *
 * All services should import `supabase` from this module
 * instead of creating their own client instances.
 *
 * Returns `null` when env vars are missing (in-memory mode).
 */

import { createClient } from '@supabase/supabase-js';

// Unique key so we don't collide with other libraries that cache on
// globalThis. The Symbol.for() registry makes the lookup stable across
// duplicate module instances (HMR loads create new local Symbols, but
// Symbol.for() returns the same one).
const GLOBAL_SINGLETON_KEY = Symbol.for('cre-financial-suite.supabase-browser-client');

function getOrCreateSupabaseClient() {
  const globalScope = /** @type {Record<string|symbol, unknown>} */ (globalThis);

  const existing = globalScope[GLOBAL_SINGLETON_KEY];
  if (existing !== undefined) {
    // Either a previously-created client OR the explicit `null` we cached
    // when env vars were missing. Either way, return what we have so
    // subsequent imports don't re-run createClient or re-log diagnostics.
    return existing;
  }

  let client = null;
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey) {
      if (import.meta.env.DEV) console.log('[supabase] Initializing client with URL:', supabaseUrl);
      if (import.meta.env.DEV) console.log('[supabase] Key presence check:', {
        url: !!supabaseUrl,
        key: !!supabaseKey,
        keyPrefix: supabaseKey.substring(0, 10) + '...',
      });
      client = createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      });
      if (import.meta.env.DEV) console.log('[supabase] Client initialized successfully');
    } else {
      console.warn('[supabase] Missing credentials — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
      if (import.meta.env.DEV) console.log('[supabase] Running in-memory mode');
    }
  } catch {
    if (import.meta.env.DEV) console.log('[supabase] Client unavailable — running in-memory mode');
  }

  globalScope[GLOBAL_SINGLETON_KEY] = client;
  return client;
}

const supabase = getOrCreateSupabaseClient();

export { supabase };
