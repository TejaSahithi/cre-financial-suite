import React from "react";

function formatValue(field) {
  if (field.status === "invalid") return "Invalid value requires review";
  if (field.displayValue) return field.displayValue;
  if (field.value === null || field.value === undefined || field.value === "") return "Not provided";
  if (typeof field.value === "boolean") return field.value ? "Yes" : "No";
  return String(field.value);
}

export default function ReviewFieldValue({ field }) {
  return <div className="text-sm text-slate-800">{formatValue(field)}</div>;
}
