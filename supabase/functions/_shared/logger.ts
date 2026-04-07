// @ts-nocheck
/**
 * Pipeline Logger
 *
 * Writes structured log entries to pipeline_logs for every pipeline step.
 * All writes are fire-and-forget — a logging failure never breaks the pipeline.
 *
 * Usage:
 *   const log = createLogger(supabaseAdmin, fileId, orgId);
 *   await log.info("parse", "Parsed 42 rows from CSV");
 *   await log.warn("validate", "3 rows failed validation", { error_count: 3 });
 *   await log.error("compute", "compute-lease failed after 3 retries", { error: "..." });
 */

export type LogLevel = "info" | "warn" | "error";

export interface PipelineLogger {
  info(step: string, message: string, metadata?: Record<string, unknown>): Promise<void>;
  warn(step: string, message: string, metadata?: Record<string, unknown>): Promise<void>;
  error(step: string, message: string, metadata?: Record<string, unknown>): Promise<void>;
}

export function createLogger(
  supabaseAdmin: any,
  fileId: string,
  orgId: string,
): PipelineLogger {
  async function write(
    level: LogLevel,
    step: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await supabaseAdmin.from("pipeline_logs").insert({
        file_id: fileId,
        org_id: orgId,
        step,
        level,
        message,
        metadata,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Never let logging break the pipeline
      console.warn(`[logger] Failed to write log (${step}/${level}):`, err?.message);
    }
  }

  return {
    info: (step, message, metadata) => write("info", step, message, metadata),
    warn: (step, message, metadata) => write("warn", step, message, metadata),
    error: (step, message, metadata) => write("error", step, message, metadata),
  };
}
