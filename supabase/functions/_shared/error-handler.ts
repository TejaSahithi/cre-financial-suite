// @ts-nocheck
/**
 * Error Handler Module
 * Task 17: Error handling and recovery
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

// ---------------------------------------------------------------------------
// PipelineError class
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "upload"
  | "parsing"
  | "validation"
  | "storage"
  | "computation";

export class PipelineError extends Error {
  error_code: string;
  category: ErrorCategory;
  details: Record<string, any>;
  timestamp: string;
  retryable: boolean;

  constructor(
    message: string,
    options: {
      error_code: string;
      category: ErrorCategory;
      details?: Record<string, any>;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "PipelineError";
    this.error_code = options.error_code;
    this.category = options.category;
    this.details = options.details ?? {};
    this.timestamp = new Date().toISOString();
    this.retryable = options.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// formatErrorResponse
// ---------------------------------------------------------------------------

/**
 * Converts any Error (or PipelineError) into a standardised JSON-serialisable
 * error response object.
 */
export function formatErrorResponse(
  error: PipelineError | Error,
): Record<string, any> {
  if (error instanceof PipelineError) {
    return {
      error: true,
      error_code: error.error_code,
      message: error.message,
      category: error.category,
      details: error.details,
      timestamp: error.timestamp,
      retryable: error.retryable,
    };
  }

  // Generic Error fallback
  return {
    error: true,
    error_code: "UNKNOWN_ERROR",
    message: error.message,
    category: "computation",
    details: {},
    timestamp: new Date().toISOString(),
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

/**
 * Determines whether an error is transient (temporary) and therefore safe to
 * retry. Returns true for network issues, database locks, connection problems,
 * and rate-limit responses. Returns false for validation failures, constraint
 * violations, and authentication errors.
 */
export function isTransientError(error: Error): boolean {
  const message = (error.message || "").toLowerCase();

  // Patterns that indicate a transient / retryable error
  const transientPatterns = [
    "timeout",
    "timed out",
    "econnrefused",
    "econnreset",
    "enotfound",
    "enetunreach",
    "connection refused",
    "connection reset",
    "network error",
    "network request failed",
    "fetch failed",
    "database is locked",
    "lock timeout",
    "deadlock",
    "too many requests",
    "rate limit",
    "429",
    "503",
    "service unavailable",
    "temporarily unavailable",
    "socket hang up",
    "epipe",
  ];

  for (const pattern of transientPatterns) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  // If it's a PipelineError, respect its retryable flag
  if (error instanceof PipelineError) {
    return error.retryable;
  }

  return false;
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

/**
 * Executes an async function with exponential-backoff retries.
 * Only retries when the error is transient (as determined by isTransientError).
 *
 * @param fn        The async function to execute.
 * @param options   Retry configuration.
 * @returns         The resolved value of fn.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 10000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry non-transient errors
      if (!isTransientError(lastError)) {
        throw lastError;
      }

      // Don't retry if we've exhausted all attempts
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff with jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelay * 0.5;
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      console.warn(
        `[error-handler] Transient error on attempt ${attempt + 1}/${maxRetries + 1}, ` +
          `retrying in ${Math.round(delay)}ms: ${lastError.message}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but satisfy TypeScript
  throw lastError;
}

// ---------------------------------------------------------------------------
// logError
// ---------------------------------------------------------------------------

export interface ErrorContext {
  org_id?: string;
  user_email?: string;
  file_id?: string;
  module_type?: string;
}

/**
 * Persists an error entry to the audit_logs table for observability.
 *
 * @param supabaseAdmin  An admin Supabase client with service-role privileges.
 * @param error          The error to log (PipelineError or generic Error).
 * @param context        Contextual information (org, user, file, etc.).
 */
export async function logError(
  supabaseAdmin: any,
  error: PipelineError | Error,
  context: ErrorContext = {},
): Promise<void> {
  const isPipelineError = error instanceof PipelineError;

  const category = isPipelineError
    ? (error as PipelineError).category
    : "error";
  const errorCode = isPipelineError
    ? (error as PipelineError).error_code
    : "UNKNOWN_ERROR";
  const details = isPipelineError
    ? (error as PipelineError).details
    : {};

  const logPayload = {
    entity_type: "error",
    action: category,
    field_changed: errorCode,
    old_value: null,
    new_value: JSON.stringify({
      message: error.message,
      details,
      stack: error.stack || null,
    }),
    org_id: context.org_id || null,
    user_email: context.user_email || null,
    created_at: new Date().toISOString(),
  };

  try {
    const { error: insertError } = await supabaseAdmin
      .from("audit_logs")
      .insert(logPayload);

    if (insertError) {
      // Don't throw — logging failures should never break the main flow.
      console.error(
        "[error-handler] Failed to write audit log:",
        insertError.message,
      );
    }
  } catch (logErr) {
    console.error(
      "[error-handler] Exception writing audit log:",
      logErr.message,
    );
  }
}
