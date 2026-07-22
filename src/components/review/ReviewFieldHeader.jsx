import React from "react";
import ReviewFieldStatus from "./ReviewFieldStatus";

export default function ReviewFieldHeader({ field }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{field.label}</h3>
        <p className="text-xs text-slate-500">{field.domain}</p>
      </div>
      <ReviewFieldStatus status={field.status} />
    </div>
  );
}
