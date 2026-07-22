import React from "react";
import { AlertTriangle, Ban, CheckCircle2, FileWarning, GitCompare, HelpCircle, History, MinusCircle, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getReviewStatusPresentation } from "@/lib/review/reviewStatusPresentation";

const ICONS = {
  check: CheckCircle2,
  alert: AlertTriangle,
  conflict: GitCompare,
  "search-x": SearchX,
  missing: HelpCircle,
  "file-warning": FileWarning,
  ban: Ban,
  history: History,
  minus: MinusCircle,
};

export default function ReviewFieldStatus({ status }) {
  const presentation = getReviewStatusPresentation(status);
  const Icon = ICONS[presentation.iconKey] || HelpCircle;
  return (
    <Badge className={`${presentation.className} inline-flex items-center gap-1`} title={presentation.guidance}>
      <Icon className="h-3 w-3" />
      {presentation.label}
    </Badge>
  );
}
