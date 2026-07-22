import React from "react";
import { Button } from "@/components/ui/button";

export default function ReviewFieldActions({ field, onAction, pending = false }) {
  if (!onAction || !field.editable) return null;
  const disabled = pending;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ type: "accept", fieldKey: field.key })}>Accept</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ type: "follow_up", fieldKey: field.key, reason: "Needs follow-up" })}>Follow Up</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ type: "clear", fieldKey: field.key, reason: "Cleared by reviewer" })}>Clear</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ type: "not_applicable", fieldKey: field.key, reason: "Not applicable" })}>N/A</Button>
    </div>
  );
}
