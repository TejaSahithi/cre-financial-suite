import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import ReviewFieldActions from "./ReviewFieldActions";
import ReviewFieldConflict from "./ReviewFieldConflict";
import ReviewFieldDerivation from "./ReviewFieldDerivation";
import ReviewFieldEvidence from "./ReviewFieldEvidence";
import ReviewFieldHeader from "./ReviewFieldHeader";
import ReviewFieldMetadata from "./ReviewFieldMetadata";
import ReviewFieldValue from "./ReviewFieldValue";

function statusGuidance(field) {
  if (field.status === "not_found") return "The source document was searched and the field was not found.";
  if (field.status === "missing") return "The expected field value is absent.";
  if (field.status === "missing_source_evidence") return "A value exists or was proposed, but supporting source evidence is unavailable.";
  if (field.status === "legacy_fallback") return "This value is displayed from the legacy fallback source.";
  return null;
}

export default function ReviewField({ field, onAction, pending = false }) {
  const guidance = statusGuidance(field);
  return (
    <Card className="rounded-md border-slate-200">
      <CardContent className="space-y-3 p-4">
        <ReviewFieldHeader field={field} />
        <ReviewFieldValue field={field} />
        {guidance && <p className="text-xs text-slate-600">{guidance}</p>}
        <ReviewFieldConflict conflict={field.conflict} />
        <ReviewFieldEvidence evidence={field.evidence} />
        <ReviewFieldDerivation derivation={field.derivation} />
        <ReviewFieldMetadata field={field} />
        {(field.requiresAttention || field.status === "needs_review" || field.status === "conflict") && <ReviewFieldActions field={field} onAction={onAction} pending={pending} />}
      </CardContent>
    </Card>
  );
}
