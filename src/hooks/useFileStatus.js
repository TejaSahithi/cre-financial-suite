import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/services/supabaseClient";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { resolveWritableOrgId } from "@/lib/orgUtils";

/**
 * Statuses that indicate work is still in progress — keep polling.
 */
const ACTIVE_STATUSES = new Set([
  "uploaded",
  "parsing",
  "pdf_parsed",   // PDF extracted, normalization pending
  "validating",
  "validated",    // transitions to review_required or storing — not terminal
  "storing",
  "stored",       // transitions to computing — not terminal
  "approved",
  "computing",
]);

/**
 * Terminal statuses — stop polling once reached.
 */
const TERMINAL_STATUSES = new Set([
  "parsed",
  "review_required",
  "completed",
  "failed",
]);

const POLL_INTERVAL_MS = 3000;
// Backoff on consecutive failures so a persistently failing endpoint is not
// hammered every 3 s: 3s → 6s → 12s → 24s → 30s (cap).
const MAX_POLL_INTERVAL_MS = 30000;
// Stop polling entirely after this many consecutive failures and surface one
// visible error instead of retrying forever.
const MAX_CONSECUTIVE_FAILURES = 10;

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
 *   pollError:  string|null,
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
  const [pollError, setPollError] = useState(null);

  // Keep a ref to the timer so we can clear it on unmount / fileId change.
  const timerRef = useRef(null);
  // Track the latest fileId to avoid stale closure updates.
  const fileIdRef = useRef(fileId);
  fileIdRef.current = fileId;
  // Acting org resolved once per hook instance. Super-admin / multi-org users
  // have no stored acting org on a fresh session; pipeline-status then throws
  // "acting org required" server-side and returns 400 on every poll. Resolving
  // via resolveWritableOrgId (same fallback invokeEdgeFunction uses) fixes the
  // header without paying a session refresh + membership query every 3 s.
  const resolvedOrgRef = useRef(undefined);
  const consecutiveFailuresRef = useRef(0);

  const resolveActingOrgId = useCallback(async () => {
    const stored = getStoredActingOrgId();
    if (stored) return stored;
    if (resolvedOrgRef.current === undefined) {
      try {
        resolvedOrgRef.current = await resolveWritableOrgId(null);
      } catch (err) {
        console.warn("[useFileStatus] could not resolve acting org:", err?.message || err);
        resolvedOrgRef.current = null;
      }
    }
    return resolvedOrgRef.current;
  }, []);

  /**
   * Fetch the current status from the Edge Function.
   * Returns the raw data object or null on failure.
   */
  const fetchStatus = useCallback(async () => {
    if (!fileIdRef.current || !supabase) return null;

    setIsLoading(true);
    try {
      const actingOrgId = await resolveActingOrgId();
      const { data, error } = await supabase.functions.invoke(
        "pipeline-status",
        {
          body: { file_id: fileIdRef.current },
          headers: actingOrgId ? { "x-acting-org-id": actingOrgId } : {},
        }
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
        setPollError(null);
      }

      return data;
    } catch (err) {
      console.error("[useFileStatus] fetch failed:", err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [resolveActingOrgId]);

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
        clearTimeout(timerRef.current);
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
      setPollError(null);
      return;
    }

    let mounted = true;
    consecutiveFailuresRef.current = 0;

    // Chained setTimeout (not setInterval) so the delay can back off on
    // consecutive failures and polling can stop entirely on a terminal
    // status or persistent errors.
    const scheduleNext = (delayMs) => {
      if (!mounted) return;
      timerRef.current = setTimeout(poll, delayMs);
    };

    const poll = async () => {
      const data = await fetchStatus();
      if (!mounted) return;

      // Stop polling if we've reached a terminal status.
      if (data?.status && TERMINAL_STATUSES.has(data.status)) {
        clearTimer();
        return;
      }

      if (data) {
        consecutiveFailuresRef.current = 0;
        scheduleNext(POLL_INTERVAL_MS);
        return;
      }

      // Failed fetch: back off, and give up after MAX_CONSECUTIVE_FAILURES
      // so a persistent 4xx/5xx can never poll forever.
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[useFileStatus] stopping polling after ${consecutiveFailuresRef.current} consecutive failures`,
        );
        setPollError(
          "Live status updates are unavailable. Refresh the page to check the latest processing status.",
        );
        clearTimer();
        return;
      }
      const backoff = Math.min(
        POLL_INTERVAL_MS * 2 ** consecutiveFailuresRef.current,
        MAX_POLL_INTERVAL_MS,
      );
      scheduleNext(backoff);
    };

    // Immediate first fetch, then self-scheduling chain.
    poll();

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
    pollError,
    refetch,
  };
}
