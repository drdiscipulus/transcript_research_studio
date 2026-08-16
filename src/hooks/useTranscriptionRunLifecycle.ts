import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelBatch,
  fetchBackendHealth,
  fetchCurrentBatch,
  startBatch,
  type BatchRunSnapshot
} from "../lib/api";
import { appVersion } from "../lib/appMetadata";
import type {
  BatchPollingState,
  TranscriptionOperationAccess
} from "../lib/transcriptionWorkspaceContracts";

const ACTIVE_BATCH_STATES = new Set(["starting", "running", "cancelling"]);
const TERMINAL_BATCH_STATES = new Set([
  "completed",
  "completed_with_warnings",
  "cancelled",
  "failed",
  "interrupted"
]);

type StartBatchPayload = Parameters<typeof startBatch>[0];

type UseTranscriptionRunLifecycleOptions = {
  operation: TranscriptionOperationAccess;
  getWorkspaceGeneration: () => number;
};

type StartRequestSnapshot = {
  payload: StartBatchPayload;
  workspaceGeneration: number;
};

type SnapshotSource = "poll" | "start" | "cancel";

function isActiveBatch(snapshot: BatchRunSnapshot | null): boolean {
  return Boolean(snapshot && ACTIVE_BATCH_STATES.has(snapshot.status));
}

function isTerminalBatch(snapshot: BatchRunSnapshot | null): boolean {
  return Boolean(snapshot && TERMINAL_BATCH_STATES.has(snapshot.status));
}

function statusRank(status: string): number {
  if (TERMINAL_BATCH_STATES.has(status)) return 4;
  if (status === "cancelling") return 3;
  if (status === "running") return 2;
  if (status === "starting") return 1;
  return 0;
}

function interruptedSnapshot(snapshot: BatchRunSnapshot, message: string): BatchRunSnapshot {
  return {
    ...snapshot,
    status: "interrupted",
    message,
    current_file_name: null,
    finished_at: new Date().toISOString(),
    error_code: "sidecar_restarted"
  };
}

export function useTranscriptionRunLifecycle({
  operation,
  getWorkspaceGeneration
}: UseTranscriptionRunLifecycleOptions) {
  const [liveBatch, setLiveBatchState] = useState<BatchRunSnapshot | null>(null);
  const [isStarting, setIsStartingState] = useState(false);
  const [cancelRequestInFlight, setCancelRequestInFlightState] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [cancelDialog, setCancelDialogState] = useState<{
    open: boolean;
    batchId: string | null;
    requestKey: string | null;
  }>({
    open: false,
    batchId: null,
    requestKey: null
  });
  const [pollingState, setPollingState] = useState<BatchPollingState>({
    health: null,
    checking: true,
    isStale: false,
    error: null,
    compatibilityError: null,
    lastUpdatedAt: null,
    consecutiveFailures: 0
  });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const lifecycleSessionSequenceRef = useRef(0);
  const activeLifecycleSessionRef = useRef<number | null>(null);
  const liveBatchRef = useRef<BatchRunSnapshot | null>(null);
  const isStartingRef = useRef(false);
  const cancelRequestInFlightRef = useRef(false);
  const cancelDialogRef = useRef<{
    batchId: string;
    runGeneration: number;
    requestKey: string;
    operationToken: number;
  } | null>(null);
  const runGenerationRef = useRef(0);
  const requestOrdinalRef = useRef(0);
  const lastAcceptedOrdinalRef = useRef(new Map<string, number>());
  const serviceInstanceRef = useRef<string | null>(null);
  const retainedInterruptedBatchIdRef = useRef<string | null>(null);
  const dismissedBatchIdRef = useRef<string | null>(null);
  const pollingEffectGenerationRef = useRef(0);

  const isLifecycleSessionActive = useCallback((session: number | null) => (
    session !== null && activeLifecycleSessionRef.current === session
  ), []);

  useEffect(() => {
    const session = lifecycleSessionSequenceRef.current + 1;
    lifecycleSessionSequenceRef.current = session;
    activeLifecycleSessionRef.current = session;
    return () => {
      if (activeLifecycleSessionRef.current === session) {
        activeLifecycleSessionRef.current = null;
      }
      runGenerationRef.current += 1;
      pollingEffectGenerationRef.current += 1;
      isStartingRef.current = false;
      cancelRequestInFlightRef.current = false;
      const dialog = cancelDialogRef.current;
      cancelDialogRef.current = null;
      if (dialog) operation.release(dialog.operationToken);
    };
  }, [operation]);

  const publishBatch = useCallback((snapshot: BatchRunSnapshot | null) => {
    if (activeLifecycleSessionRef.current === null) return;
    liveBatchRef.current = snapshot;
    setLiveBatchState(snapshot);
    if (snapshot && isTerminalBatch(snapshot)) {
      const dialog = cancelDialogRef.current;
      if (dialog) {
        cancelDialogRef.current = null;
        setCancelDialogState({ open: false, batchId: null, requestKey: null });
        operation.release(dialog.operationToken);
      }
      cancelRequestInFlightRef.current = false;
      setCancelRequestInFlightState(false);
      setCancellationError(null);
    }
  }, [operation]);

  const applySnapshot = useCallback((
    snapshot: BatchRunSnapshot,
    source: SnapshotSource,
    requestOrdinal: number,
    capturedRunGeneration: number,
    lifecycleSession: number,
    expectedBatchId?: string | null
  ): boolean => {
    if (
      !isLifecycleSessionActive(lifecycleSession)
      || capturedRunGeneration !== runGenerationRef.current
    ) {
      return false;
    }

    const current = liveBatchRef.current;
    if (snapshot.status === "idle" || !snapshot.batch_id) {
      if (source !== "poll" || isStartingRef.current) {
        return false;
      }
      if (current && isActiveBatch(current)) {
        retainedInterruptedBatchIdRef.current = current.batch_id;
        publishBatch(interruptedSnapshot(
          current,
          "The local service no longer has this run. It was not submitted again."
        ));
        return true;
      }
      return false;
    }

    if (expectedBatchId && snapshot.batch_id !== expectedBatchId) {
      return false;
    }
    if (snapshot.batch_id === dismissedBatchIdRef.current) {
      return false;
    }
    if (retainedInterruptedBatchIdRef.current) {
      return false;
    }

    if (current?.batch_id && current.batch_id !== snapshot.batch_id && source !== "start") {
      if (isActiveBatch(current) || source !== "poll") return false;
    }

    const lastOrdinal = lastAcceptedOrdinalRef.current.get(snapshot.batch_id) ?? 0;
    if (current?.batch_id === snapshot.batch_id) {
      const currentRank = statusRank(current.status);
      const nextRank = statusRank(snapshot.status);
      if (nextRank < currentRank) return false;
      if (nextRank === currentRank && requestOrdinal < lastOrdinal) return false;
    }

    lastAcceptedOrdinalRef.current.set(snapshot.batch_id, Math.max(lastOrdinal, requestOrdinal));
    dismissedBatchIdRef.current = null;
    publishBatch(snapshot);
    if (source === "start" || source === "cancel") {
      setStartError(null);
      setCancellationError(null);
    }
    return true;
  }, [isLifecycleSessionActive, publishBatch]);

  const start = useCallback(async (
    createRequest: () => StartRequestSnapshot | null
  ): Promise<boolean> => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return false;
    const operationToken = operation.acquire("start");
    if (operationToken === null || isStartingRef.current || isActiveBatch(liveBatchRef.current)) {
      if (operationToken !== null) operation.release(operationToken);
      return false;
    }

    const request = createRequest();
    if (!request || request.workspaceGeneration !== getWorkspaceGeneration()) {
      operation.release(operationToken);
      return false;
    }

    isStartingRef.current = true;
    setIsStartingState(true);
    setStartError(null);
    setCancellationError(null);
    retainedInterruptedBatchIdRef.current = null;
    dismissedBatchIdRef.current = null;
    const runGeneration = runGenerationRef.current + 1;
    runGenerationRef.current = runGeneration;
    const requestOrdinal = requestOrdinalRef.current + 1;
    requestOrdinalRef.current = requestOrdinal;

    try {
      const snapshot = await startBatch(request.payload);
      if (
        !isLifecycleSessionActive(lifecycleSession)
        || request.workspaceGeneration !== getWorkspaceGeneration()
      ) {
        return false;
      }
      return applySnapshot(snapshot, "start", requestOrdinal, runGeneration, lifecycleSession);
    } catch (error) {
      if (
        isLifecycleSessionActive(lifecycleSession)
        && runGenerationRef.current === runGeneration
        && request.workspaceGeneration === getWorkspaceGeneration()
      ) {
        setStartError(error instanceof Error ? error.message : "Batch could not be started.");
      }
      return false;
    } finally {
      if (isLifecycleSessionActive(lifecycleSession) && runGenerationRef.current === runGeneration) {
        isStartingRef.current = false;
        setIsStartingState(false);
      }
      operation.release(operationToken);
    }
  }, [applySnapshot, getWorkspaceGeneration, isLifecycleSessionActive, operation]);

  const requestCancellation = useCallback((): boolean => {
    if (activeLifecycleSessionRef.current === null) return false;
    const current = liveBatchRef.current;
    if (
      !current?.batch_id
      || !isActiveBatch(current)
      || current.status === "cancelling"
      || cancelRequestInFlightRef.current
      || cancelDialogRef.current
    ) {
      return false;
    }
    const operationToken = operation.acquire("cancel-dialog");
    if (operationToken === null) return false;
    const requestKey = `${runGenerationRef.current}:${current.batch_id}`;
    cancelDialogRef.current = {
      batchId: current.batch_id,
      runGeneration: runGenerationRef.current,
      requestKey,
      operationToken
    };
    setCancelDialogState({ open: true, batchId: current.batch_id, requestKey });
    return true;
  }, [operation]);

  const cancelCancellationDialog = useCallback((requestKey: string | null) => {
    if (activeLifecycleSessionRef.current === null) return;
    const dialog = cancelDialogRef.current;
    if (!dialog || requestKey !== dialog.requestKey) return;
    cancelDialogRef.current = null;
    setCancelDialogState({ open: false, batchId: null, requestKey: null });
    operation.release(dialog.operationToken);
  }, [operation]);

  const confirmCancellation = useCallback(async (requestKey: string | null): Promise<boolean> => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return false;
    const dialog = cancelDialogRef.current;
    const current = liveBatchRef.current;
    if (
      !dialog
      || requestKey !== dialog.requestKey
      || !current?.batch_id
      || current.batch_id !== dialog.batchId
      || dialog.runGeneration !== runGenerationRef.current
      || !isActiveBatch(current)
      || current.status === "cancelling"
    ) {
      return false;
    }

    cancelDialogRef.current = null;
    setCancelDialogState({ open: false, batchId: null, requestKey: null });
    operation.release(dialog.operationToken);

    const operationToken = operation.acquire("cancel-request");
    if (operationToken === null || cancelRequestInFlightRef.current) {
      if (operationToken !== null) operation.release(operationToken);
      return false;
    }
    cancelRequestInFlightRef.current = true;
    setCancelRequestInFlightState(true);
    setCancellationError(null);
    const runGeneration = runGenerationRef.current;
    const requestOrdinal = requestOrdinalRef.current + 1;
    requestOrdinalRef.current = requestOrdinal;
    const expectedBatchId = current.batch_id;

    try {
      const snapshot = await cancelBatch();
      return applySnapshot(
        snapshot,
        "cancel",
        requestOrdinal,
        runGeneration,
        lifecycleSession,
        expectedBatchId
      );
    } catch (error) {
      const retained = liveBatchRef.current;
      if (
        isLifecycleSessionActive(lifecycleSession)
        && runGenerationRef.current === runGeneration
        && retained?.batch_id === expectedBatchId
        && isActiveBatch(retained)
        && !isTerminalBatch(retained)
      ) {
        setCancellationError(error instanceof Error ? error.message : "Cancellation request failed.");
      }
      return false;
    } finally {
      if (isLifecycleSessionActive(lifecycleSession) && runGenerationRef.current === runGeneration) {
        cancelRequestInFlightRef.current = false;
        setCancelRequestInFlightState(false);
      }
      operation.release(operationToken);
    }
  }, [applySnapshot, isLifecycleSessionActive, operation]);

  const retryPolling = useCallback(() => {
    if (activeLifecycleSessionRef.current === null) return;
    setRefreshGeneration((generation) => generation + 1);
  }, []);

  const resetForNewRun = useCallback((): boolean => {
    if (activeLifecycleSessionRef.current === null) return false;
    if (isStartingRef.current || isActiveBatch(liveBatchRef.current) || cancelRequestInFlightRef.current) {
      return false;
    }
    const dialog = cancelDialogRef.current;
    if (dialog) {
      cancelDialogRef.current = null;
      setCancelDialogState({ open: false, batchId: null, requestKey: null });
      operation.release(dialog.operationToken);
    }
    dismissedBatchIdRef.current = liveBatchRef.current?.batch_id ?? null;
    retainedInterruptedBatchIdRef.current = null;
    runGenerationRef.current += 1;
    publishBatch(null);
    setStartError(null);
    setCancellationError(null);
    return true;
  }, [operation, publishBatch]);

  useEffect(() => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return;
    const activeSession = lifecycleSession;
    const effectGeneration = pollingEffectGenerationRef.current + 1;
    pollingEffectGenerationRef.current = effectGeneration;
    let timerId: number | null = null;
    let failures = 0;

    async function poll(): Promise<void> {
      const capturedRunGeneration = runGenerationRef.current;
      const requestOrdinal = requestOrdinalRef.current + 1;
      requestOrdinalRef.current = requestOrdinal;
      let nextDelay = isActiveBatch(liveBatchRef.current) ? 1_000 : 10_000;
      try {
        const health = await fetchBackendHealth();
        if (
          !isLifecycleSessionActive(activeSession)
          || pollingEffectGenerationRef.current !== effectGeneration
        ) return;

        const nextInstance = health.instance_id?.trim() || null;
        const previousInstance = serviceInstanceRef.current;
        if (nextInstance) serviceInstanceRef.current = nextInstance;
        if (
          previousInstance
          && nextInstance
          && previousInstance !== nextInstance
          && capturedRunGeneration === runGenerationRef.current
        ) {
          const current = liveBatchRef.current;
          if (current?.batch_id && isActiveBatch(current)) {
            retainedInterruptedBatchIdRef.current = current.batch_id;
            publishBatch(interruptedSnapshot(
              current,
              "The local service restarted during this run. The run was not submitted again."
            ));
          }
        }

        if (!retainedInterruptedBatchIdRef.current) {
          const snapshot = await fetchCurrentBatch();
          if (
            !isLifecycleSessionActive(activeSession)
            || pollingEffectGenerationRef.current !== effectGeneration
          ) return;
          applySnapshot(snapshot, "poll", requestOrdinal, capturedRunGeneration, activeSession);
        }

        failures = 0;
        nextDelay = isActiveBatch(liveBatchRef.current) ? 1_000 : 10_000;
        setPollingState({
          health,
          checking: false,
          isStale: false,
          error: null,
          compatibilityError: nextInstance && health.started_at
            ? null
            : `The connected sidecar is older than this desktop beta and cannot report restart identity. Install or restart the matching ${appVersion} service.`,
          lastUpdatedAt: Date.now(),
          consecutiveFailures: 0
        });
      } catch (error) {
        if (
          !isLifecycleSessionActive(activeSession)
          || pollingEffectGenerationRef.current !== effectGeneration
        ) return;
        failures += 1;
        nextDelay = Math.min(10_000, 1_000 * (2 ** Math.min(failures - 1, 4)));
        setPollingState((current) => ({
          ...current,
          checking: false,
          isStale: Boolean(liveBatchRef.current),
          error: error instanceof Error ? error.message : "The local service could not be reached.",
          consecutiveFailures: failures
        }));
      } finally {
        if (
          isLifecycleSessionActive(activeSession)
          && pollingEffectGenerationRef.current === effectGeneration
        ) {
          timerId = window.setTimeout(() => void poll(), nextDelay);
        }
      }
    }

    void poll();
    return () => {
      pollingEffectGenerationRef.current += 1;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [applySnapshot, isLifecycleSessionActive, publishBatch, refreshGeneration]);

  const batchIsActive = isActiveBatch(liveBatch);
  const cancellationPending = cancelRequestInFlight || liveBatch?.status === "cancelling";
  const configurationLocked = isStarting || batchIsActive || cancellationPending;

  const state = useMemo(() => ({
    liveBatch,
    batchIsActive,
    isStarting,
    cancellationPending,
    configurationLocked,
    startError,
    cancellationError,
    cancelDialog,
    pollingState
  }), [
    batchIsActive,
    cancelDialog,
    cancellationError,
    cancellationPending,
    configurationLocked,
    isStarting,
    liveBatch,
    pollingState,
    startError
  ]);

  const refs = useMemo(() => ({
    isConfigurationLocked: () => isStartingRef.current || isActiveBatch(liveBatchRef.current) || cancelRequestInFlightRef.current,
    isNewRunBlocked: () => isStartingRef.current || isActiveBatch(liveBatchRef.current) || cancelRequestInFlightRef.current,
    currentBatch: () => liveBatchRef.current
  }), []);

  const actions = useMemo(() => ({
    start,
    requestCancellation,
    cancelCancellationDialog,
    confirmCancellation,
    retryPolling,
    resetForNewRun
  }), [
    cancelCancellationDialog,
    confirmCancellation,
    requestCancellation,
    resetForNewRun,
    retryPolling,
    start
  ]);

  return {
    state,
    refs,
    actions
  };
}
