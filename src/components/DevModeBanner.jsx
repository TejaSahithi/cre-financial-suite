/**
 * DevModeBanner — shows a dismissible warning when running without Supabase.
 * Only visible when VITE_SUPABASE_URL is not set (local dev without backend).
 * In production this component renders nothing.
 */
import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { supabase } from '@/services/supabaseClient';

const IS_DEV_MODE = !supabase;

export default function DevModeBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (!IS_DEV_MODE || dismissed) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-white text-xs font-semibold flex items-center justify-between px-4 py-2 shadow-md">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
        <span>
          DEV MODE — No Supabase configured. Add <code className="bg-amber-600 px-1 rounded">VITE_SUPABASE_URL</code> and <code className="bg-amber-600 px-1 rounded">VITE_SUPABASE_ANON_KEY</code> to your <code className="bg-amber-600 px-1 rounded">.env</code> to connect to the real database.
        </span>
      </div>
      <button onClick={() => setDismissed(true)} className="ml-4 flex-shrink-0 hover:opacity-75">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
