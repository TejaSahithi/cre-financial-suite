import React from 'react';

export default function LoadingScreen({ pageName }) {
  const label = pageName
    ? pageName.replace(/([A-Z])/g, ' $1').trim()
    : null;

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-white/80">
      <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-700 rounded-full animate-spin" />
      {label && (
        <p className="text-sm text-slate-500 font-medium">Loading {label}…</p>
      )}
    </div>
  );
}
