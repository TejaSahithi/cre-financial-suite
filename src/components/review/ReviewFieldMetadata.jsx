import React from "react";

export default function ReviewFieldMetadata({ field }) {
  return (
    <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
      <span>Source: {field.source.replace(/_/g, " ")}</span>
      {typeof field.confidence === "number" && <span>Confidence: {Math.round(field.confidence * 100)}%</span>}
      {field.reasonCodes.length > 0 && <span>Reasons: {field.reasonCodes.join(", ")}</span>}
      {field.reviewerAction?.state && field.reviewerAction.state !== "none" && <span>Reviewer: {field.reviewerAction.state}</span>}
    </div>
  );
}
