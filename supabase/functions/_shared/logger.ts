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
  function normalizeMetadata(input: Record<string, unknown> = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input || {})) {
      if (value instanceof Error) {
        out[key] = {
          name: value.name,
          message: value.message,
          stack: value.stack ?? null,
        };
        continue;
      }

      if (typeof value === "bigint") {
        out[key] = String(value);
        continue;
      }

      out[key] = value;
    }

    return out;
  }

  async function write(
    level: LogLevel,
    step: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const payload = {
        file_id: fileId,
        org_id: orgId,
        step,
        level,
        message,
        metadata: normalizeMetadata(metadata),
        timestamp: new Date().toISOString(),
      };

      const { error } = await supabaseAdmin.from("pipeline_logs").insert(payload);
      if (error) throw error;
    } catch (err) {
      // Never let logging break the pipeline
      console.warn(
        `[logger] Failed to write log (${step}/${level}) for file ${fileId} in org ${orgId}:`,
        {
          error: err?.message || String(err),
          message,
          metadata: normalizeMetadata(metadata),
        },
      );
    }
  }

  return {
    info: (step, message, metadata) => write("info", step, message, metadata),
    warn: (step, message, metadata) => write("warn", step, message, metadata),
    error: (step, message, metadata) => write("error", step, message, metadata),
  };
}
