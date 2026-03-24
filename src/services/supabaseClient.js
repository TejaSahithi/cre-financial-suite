/**
 * Shared Supabase Client
 *
 * Single point of initialization for the Supabase client.
 * All services should import `supabase` from this module
 * instead of creating their own client instances.
 *
 * Returns `null` when env vars are missing (in-memory mode).
 */

import { createClient } from '@supabase/supabase-js';

let supabase = null;

try {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
    console.log('[supabase] Client initialized');
  } else {
    console.log('[supabase] No credentials — running in-memory mode');
  }
} catch {
  console.log('[supabase] Client unavailable — running in-memory mode');
}

export { supabase };
