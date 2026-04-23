import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/services/supabaseClient";

/**
 * Statuses that indicate work is still in progress — keep polling.
 */
const ACTIVE_STATUSES = new Set([
  "uploaded",
  "parsing",
  "pdf_parsed",   // PDF extracted, normalization pending
  "validating",
  "storing",
  "approved",
  "computing",
]);

/**
 * Terminal statuses — stop polling once reached.
 */
const TERMINAL_STATUSES = new Set([
  "parsed",
  "review_required",
  "validated",
  "stored",
  "completed",
  "failed",
]);

const POLL_INTERVAL_MS = 3000;

/**
 * Custom hook that polls the pipeline-status Edge Function for
 * real-time file processing status.
 *
 * @param {string|null} fileId - The file ID to track. Pass null to disable polling.
 * @returns {{
 *   status:     string|null,
 *   progress:   number,
 *   errors:     Array,
 *   validCount: number,
 *   errorCount: number,
 *   isLoading:  boolean,
 *   refetch:    () => Promise<void>,
 * }}
 */
export default function useFileStatus(fileId) {
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState([]);
  const [validCount, setValidCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // Keep a ref to the timer so we can clear it on unmount / fileId change.
  const timerRef = useRef(null);
  // Track the latest fileId to avoid stale closure updates.
  const fileIdRef = useRef(fileId);
  fileIdRef.current = fileId;

  /**
   * Fetch the current status from the Edge Function.
   * Returns the raw data object or null on failure.
   */
  const fetchStatus = useCallback(async () => {
    if (!fileIdRef.current || !supabase) return null;

    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "pipeline-status",
        { body: { file_id: fileIdRef.current } }
      );

      if (error) {
        console.error("[useFileStatus] Edge Function error:", error);
        return null;
      }

      // Apply response fields
      if (data) {
        setStatus(data.status ?? null);
        setProgress(
          typeof data.progress_percentage === "number"
            ? data.progress_percentage
            : typeof data.progress === "number"
              ? data.progress
              : 0,
        );
        setErrors(Array.isArray(data.validation_errors) ? data.validation_errors : []);
        setValidCount(typeof data.valid_count === "number" ? data.valid_count : 0);
        setErrorCount(typeof data.error_count === "number" ? data.error_count : 0);
      }

      return data;
    } catch (err) {
      console.error("[useFileStatus] fetch failed:", err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Public refetch — can be called manually by consumers.
   */
  const refetch = useCallback(async () => {
    await fetchStatus();
  }, [fetchStatus]);

  // --- polling lifecycle ---
  useEffect(() => {
    // Cleanup helper
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // If no fileId, reset state and bail out.
    if (!fileId) {
      clearTimer();
      setStatus(null);
      setProgress(0);
      setErrors([]);
      setValidCount(0);
      setErrorCount(0);
      setIsLoading(false);
      return;
    }

    // Kick off an immediate fetch, then start the interval.
    let mounted = true;

    const poll = async () => {
      const data = await fetchStatus();

      // Stop polling if we've reached a terminal status.
      if (data?.status && TERMINAL_STATUSES.has(data.status)) {
        clearTimer();
      }
    };

    // Immediate first fetch
    poll();

    // Start interval polling
    timerRef.current = setInterval(() => {
      if (!mounted) return;
      poll();
    }, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      clearTimer();
    };
  }, [fileId, fetchStatus]);

  return {
    status,
    progress,
    errors,
    validCount,
    errorCount,
    isLoading,
    refetch,
  };
}
