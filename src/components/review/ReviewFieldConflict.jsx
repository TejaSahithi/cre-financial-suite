import React from "react";

export default function ReviewFieldConflict({ conflict }) {
  if (!conflict) return null;
  return (
    <div className="rounded border border-red-100 bg-red-50 p-2 text-xs text-red-800">
      <div className="font-semibold">Conflict detail</div>
      {conflict.summary && <p>{conflict.summary}</p>}
      <p>Selected: {conflict.selectedCandidateId || "None"}</p>
      {conflict.rejectedCandidateIds.length > 0 && <p>Rejected: {conflict.rejectedCandidateIds.join(", ")}</p>}
      {conflict.reasonCodes.length > 0 && <p>Reasons: {conflict.reasonCodes.join(", ")}</p>}
    </div>
  );
}
