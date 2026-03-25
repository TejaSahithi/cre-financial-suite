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
    console.log('[supabase] Initializing client with URL:', supabaseUrl);
    console.log('[supabase] Key presence check:', { 
      url: !!supabaseUrl, 
      key: !!supabaseKey,
      keyPrefix: supabaseKey.substring(0, 10) + '...'
    });
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
    console.log('[supabase] Client initialized successfully');
  } else {
    console.warn('[supabase] Missing credentials — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
    console.log('[supabase] Running in-memory mode');
  }
} catch {
  console.log('[supabase] Client unavailable — running in-memory mode');
}

export { supabase };
