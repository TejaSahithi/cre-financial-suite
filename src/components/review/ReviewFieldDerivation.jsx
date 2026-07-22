import React from "react";

export default function ReviewFieldDerivation({ derivation }) {
  if (!derivation) return null;
  return (
    <details className="text-xs text-slate-600">
      <summary className="cursor-pointer font-medium text-slate-700">Derivation</summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-950 p-2 text-[11px] text-slate-50">{JSON.stringify(derivation, null, 2)}</pre>
    </details>
  );
}
