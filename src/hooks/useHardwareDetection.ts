import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchHardwareStatus,
  retryHardwareScan,
  type HardwareScanSnapshot
} from "../lib/api";

const POLL_INTERVAL_MS = 750;
const POLL_REQUEST_ERROR = "Hardware status is temporarily unavailable. Retrying automatically.";
const RETRY_REQUEST_ERROR = "Hardware scan could not be restarted. CPU processing remains available.";

const initialSnapshot: HardwareScanSnapshot = {
  generation: 0,
  status: "checking",
  phase: "system",
  message: "Reading system hardware...",
  system: null,
  hardware: null,
  retryable: false
};

export function useHardwareDetection() {
  const [snapshot, setSnapshot] = useState<HardwareScanSnapshot>(initialSnapshot);
  const [requestError, setRequestError] = useState<string | null>(null);
  const snapshotRef = useRef<HardwareScanSnapshot>(initialSnapshot);
  const lifecycleRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSequenceRef = useRef(0);
  const requestPendingRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const publishSnapshot = useCallback((next: HardwareScanSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const poll = useCallback(async (lifecycle: number): Promise<void> => {
    if (!mountedRef.current || lifecycleRef.current !== lifecycle || requestPendingRef.current !== null) return;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    requestPendingRef.current = requestId;
    try {
      const next = await fetchHardwareStatus();
      if (!mountedRef.current || lifecycleRef.current !== lifecycle) return;
      publishSnapshot(next);
      setRequestError(null);
      if (next.status === "checking") {
        timerRef.current = setTimeout(() => void poll(lifecycle), POLL_INTERVAL_MS);
      }
    } catch {
      if (!mountedRef.current || lifecycleRef.current !== lifecycle) return;
      setRequestError(POLL_REQUEST_ERROR);
      timerRef.current = setTimeout(() => void poll(lifecycle), POLL_INTERVAL_MS);
    } finally {
      if (requestPendingRef.current === requestId) requestPendingRef.current = null;
    }
  }, [publishSnapshot]);

  const refresh = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimer();
    requestPendingRef.current = null;
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    publishSnapshot(initialSnapshot);
    setRequestError(null);
    void poll(lifecycle);
  }, [clearTimer, poll, publishSnapshot]);

  const retry = useCallback(async (): Promise<boolean> => {
    if (
      !mountedRef.current
      || !snapshotRef.current.retryable
      || requestPendingRef.current !== null
    ) return false;
    clearTimer();
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    requestPendingRef.current = requestId;
    setRequestError(null);
    try {
      const next = await retryHardwareScan();
      if (!mountedRef.current || lifecycleRef.current !== lifecycle) return false;
      publishSnapshot(next);
      setRequestError(null);
      if (next.status === "checking") {
        timerRef.current = setTimeout(() => void poll(lifecycle), POLL_INTERVAL_MS);
      }
      return Boolean(next.retry_started);
    } catch {
      if (!mountedRef.current || lifecycleRef.current !== lifecycle) return false;
      setRequestError(RETRY_REQUEST_ERROR);
      return false;
    } finally {
      if (requestPendingRef.current === requestId) requestPendingRef.current = null;
    }
  }, [clearTimer, poll, publishSnapshot]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      requestPendingRef.current = null;
      clearTimer();
    };
  }, [clearTimer, refresh]);

  return {
    snapshot,
    requestError,
    retry,
    refresh
  };
}
