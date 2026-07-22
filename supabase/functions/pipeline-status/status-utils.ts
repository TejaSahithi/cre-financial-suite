// @ts-nocheck

export const STATUS_PROGRESS: Record<string, number> = {
  uploaded: 5,
  parsing: 15,
  parsed: 30,
  pdf_parsed: 35,
  validating: 45,
  validated: 55,
  review_required: 60,
  approved: 65,
  storing: 70,
  stored: 80,
  computing: 90,
  completed: 100,
  processed: 100,
};

export function getProgressPercentage(record: Record<string, any>): number {
  if (typeof record?.progress_percentage === "number" && record.progress_percentage > 0) {
    return record.progress_percentage;
  }
  if (record?.status === "failed") return 0;
  return STATUS_PROGRESS[record?.status] ?? 0;
}

export function isMissingSchemaError(error: any): boolean {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    text.includes("42703") ||
    text.includes("pgrst204") ||
    text.includes("schema cache") ||
    /column .* does not exist/i.test(text) ||
    /could not find .* column/i.test(text) ||
    /relation .* does not exist/i.test(text)
  );
}

export function compactText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function extractPipelineMetadata(record: Record<string, any> | null | undefined): Record<string, any> {
  return (
    record?.ui_review_payload?.metadata?.pipeline ||
    record?.normalized_output?.metadata?.pipeline ||
    record?.docling_raw?._metadata?.pipeline ||
    record?.docling_raw?._metadata ||
    {}
  );
}

export function summarizeJson(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
    };
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return {
      type: "object",
      keys: Object.keys(objectValue).slice(0, 25),
    };
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }
  return value;
}

export function summarizePipelineJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const objectValue = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(objectValue)) {
    if (/text|source|clause|url|phone|email|tenant|landlord|address/i.test(key)) {
      if (typeof entry === "string") {
        summary[key] = { type: "string", chars: entry.length };
      } else {
        summary[key] = summarizeJson(entry);
      }
    } else if (typeof entry === "object") {
      summary[key] = summarizeJson(entry);
    } else {
      summary[key] = entry;
    }
  }
  return summary;
}

export function summarizeNormalizedOutput(normalizedOutput: unknown): Record<string, unknown> | null {
  if (!normalizedOutput || typeof normalizedOutput !== "object" || Array.isArray(normalizedOutput)) return null;
  const output = normalizedOutput as Record<string, any>;
  const metadata = output.metadata || {};
  const pipeline = metadata.pipeline || {};
  return {
    parser_status: pipeline.parser_status ?? metadata.parser_status ?? null,
    normalize_status: pipeline.normalize_status ?? metadata.normalize_status ?? null,
    ai_status: pipeline.ai_status ?? metadata.ai_status ?? null,
    mapped_fields_count: pipeline.mapped_fields_count ?? metadata.mapped_fields_count ?? null,
    dynamic_terms_count: pipeline.dynamic_terms_count ?? metadata.dynamic_terms_count ?? null,
    lease_clauses_count: pipeline.lease_clauses_count ?? metadata.lease_clauses_count ?? null,
    expense_rules_count: pipeline.expense_rules_count ?? metadata.expense_rules_count ?? null,
  };
}

export function sanitizeJob(job: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!job) return null;
  return {
    id: job.id,
    job_type: job.job_type,
    status: job.status,
    stage: job.stage,
    attempt: job.attempt,
    max_attempts: job.max_attempts,
    available_at: job.available_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    error_code: job.error_code,
    error_message: job.error_message,
    counts: job.counts ?? {},
    input_summary: summarizeJson(job.input),
    metadata_summary: summarizePipelineJson(job.metadata),
  };
}

export function sanitizeLog(log: Record<string, any>): Record<string, any> {
  return {
    stage: log.stage ?? log.step ?? null,
    status: log.status ?? log.level ?? null,
    error_code: log.error_code ?? log.metadata?.error_code ?? null,
    error_message: log.error_message ?? (log.level === "error" ? log.message : null),
    message: log.message ?? null,
    created_at: log.created_at ?? log.timestamp ?? null,
    counts: log.counts ?? log.metadata?.counts ?? null,
    metadata_summary: summarizePipelineJson(log.metadata),
  };
}

function deriveDisplayStateCore(record: Record<string, any>, latestJob: Record<string, any> | null): {
  display_state: string;
  message: string;
  next_action: string | null;
} {
  const status = compactText(record?.status).toLowerCase();
  const reviewStatus = compactText(record?.review_status).toLowerCase();
  const processingStatus = compactText(record?.processing_status).toLowerCase();
  const reviewRequired = record?.review_required === true;
  const pipeline = extractPipelineMetadata(record);
  const pipelineText = compactText([
    pipeline?.parser_status,
    pipeline?.normalize_status,
    pipeline?.ai_status,
    pipeline?.error_code,
    pipeline?.error_message,
    processingStatus,
    record?.error_message,
  ].filter(Boolean).join(" "));

  if (latestJob?.status === "queued") {
    return {
      display_state: "queued",
      message: "Lease extraction is queued.",
      next_action: "wait",
    };
  }

  if (latestJob?.status === "running") {
    if (latestJob.stage === "parse") {
      return { display_state: "parsing", message: "The document parser is reading the lease.", next_action: "wait" };
    }
    if (latestJob.stage === "normalize") {
      return { display_state: "normalizing", message: "Lease text is being normalized for review.", next_action: "wait" };
    }
    if (latestJob.stage === "review_draft") {
      return { display_state: "creating_review", message: "The Lease Review draft is being created.", next_action: "wait" };
    }
    return { display_state: "extracting", message: "Lease extraction is running.", next_action: "wait" };
  }

  if (latestJob?.status === "failed" && latestJob?.available_at && new Date(latestJob.available_at).getTime() > Date.now()) {
    return {
      display_state: "retry_pending",
      message: "Lease extraction failed and is waiting for its retry window.",
      next_action: "wait",
    };
  }

  if (/empty_parse|insufficient_parse|blocked|manual_review_fallback|parse_completed_empty_text|parse_completed_insufficient_text/i.test(pipelineText)) {
    return {
      display_state: "blocked",
      message: pipeline?.error_message || record?.error_message || "The document could not be parsed into readable lease text.",
      next_action: "retry",
    };
  }

  if (status === "review_required" || reviewRequired || ["pending", "saved", "manual_review_required", "review_ready"].includes(reviewStatus)) {
    return {
      display_state: "ready_for_review",
      message: "Lease extraction is ready for review.",
      next_action: "open_review",
    };
  }

  if (status === "failed" || latestJob?.status === "failed") {
    return {
      display_state: "failed",
      message: latestJob?.error_message || record?.error_message || "Lease extraction failed.",
      next_action: "retry",
    };
  }

  if (["validated", "storing", "stored", "computing", "completed", "processed"].includes(status)) {
    return { display_state: "complete", message: "Lease processing is complete.", next_action: null };
  }

  if (status === "parsing" || (latestJob?.status !== "completed" && latestJob?.stage === "parse")) {
    return { display_state: "parsing", message: "The document parser is reading the lease.", next_action: "wait" };
  }
  if (status === "pdf_parsed" || status === "validating" || (latestJob?.status !== "completed" && latestJob?.stage === "normalize")) {
    return { display_state: "normalizing", message: "Lease text is being normalized for review.", next_action: "wait" };
  }
  if (status === "uploaded") {
    return { display_state: "queued", message: "Lease extraction is starting.", next_action: "wait" };
  }

  return {
    display_state: "unknown",
    message: "Lease extraction status is not available yet.",
    next_action: null,
  };
}

// P0.4/P0.7: additive wrapper — existing consumers (LeaseUpload.jsx,
// FileHistory.jsx, and deriveDisplayStateCore's own three fields above) are
// unchanged; review_readiness/enrichment_state/artifact_sync_status are new
// fields read directly from the uploaded_files columns (real columns as of
// P0.4, not a JSONB dig) for the first consumer of this data,
// LeaseReview.jsx (P0.7), to use as the authoritative signal instead of its
// own ad hoc ui_review_payload-only derivation.
export function deriveDisplayState(record: Record<string, any>, latestJob: Record<string, any> | null): {
  display_state: string;
  message: string;
  next_action: string | null;
  review_readiness: string | null;
  review_readiness_reasons: unknown[];
  enrichment_state: string | null;
  artifact_sync_status: string | null;
} {
  const core = deriveDisplayStateCore(record, latestJob);
  return {
    ...core,
    review_readiness: record?.review_readiness ?? null,
    review_readiness_reasons: Array.isArray(record?.review_readiness_reasons) ? record.review_readiness_reasons : [],
    enrichment_state: record?.enrichment_status ?? record?.ui_review_payload?.enrichment_status ?? null,
    artifact_sync_status: record?.artifact_sync_status ?? null,
  };
}