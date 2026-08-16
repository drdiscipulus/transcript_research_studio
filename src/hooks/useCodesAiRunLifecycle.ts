import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelCodesAiRun,
  fetchCodesAiRun,
  startCodesAiRun,
  type CodesAiRunMutationPayload,
  type CodesAiRunSnapshot,
  type CodesAiRunStartPayload,
  type CodesAiRunStatus,
  type CodesAiRunTask
} from "../lib/api";

export const CODES_AI_ACTIVE_STATUSES: ReadonlySet<CodesAiRunStatus> = new Set([
  "pending",
  "starting",
  "running",
  "cancelling"
]);

export const CODES_AI_TERMINAL_STATUSES: ReadonlySet<CodesAiRunStatus> = new Set([
  "completed",
  "cancelled",
  "failed"
]);

const STATUS_ORDER: Record<CodesAiRunStatus, number> = {
  pending: 0,
  starting: 1,
  running: 2,
  cancelling: 3,
  completed: 4,
  cancelled: 4,
  failed: 4
};

const RECONNECTING_MESSAGE = "Connection to the local service was interrupted. Reconnecting…";
const LOST_RUN_MESSAGE = "The local service lost this AI run. Start it again when you are ready.";

type SnapshotExpectation = {
  projectId: string;
  sessionKey: string;
  runId: string;
  task: CodesAiRunTask;
  generation: number;
  requestId: number;
};

type CodesAiRunLifecycleOptions = {
  projectId: string;
  sessionKey?: string;
  onCompleted: (snapshot: CodesAiRunSnapshot) => void;
  onFailed: (snapshot: CodesAiRunSnapshot) => void;
};

type PrepareCodesAiRunStartPayload = () => Promise<CodesAiRunStartPayload | null>;

function isSnapshotProgressionAllowed(current: CodesAiRunStatus, incoming: CodesAiRunStatus) {
  if (CODES_AI_TERMINAL_STATUSES.has(current)) return false;
  return STATUS_ORDER[incoming] >= STATUS_ORDER[current];
}

function captureStartPayload(payload: CodesAiRunStartPayload): CodesAiRunStartPayload {
  return {
    ...payload,
    handle: { ...payload.handle },
    scope: payload.scope ? { ...payload.scope } : undefined,
    segment_ids: payload.segment_ids ? [...payload.segment_ids] : undefined,
    code_ids: payload.code_ids ? [...payload.code_ids] : undefined,
    selected_code_ids: payload.selected_code_ids ? [...payload.selected_code_ids] : undefined,
    code_draft: payload.code_draft ? { ...payload.code_draft } : undefined,
    theme_draft: payload.theme_draft ? { ...payload.theme_draft } : undefined
  };
}

export function useCodesAiRunLifecycle({
  projectId,
  sessionKey = projectId,
  onCompleted,
  onFailed
}: CodesAiRunLifecycleOptions) {
  const [run, setRun] = useState<CodesAiRunSnapshot | null>(null);
  const [startingTask, setStartingTask] = useState<CodesAiRunTask | null>(null);
  const [cancellationPending, setCancellationPending] = useState(false);
  const [reconnectingMessage, setReconnectingMessage] = useState("");
  const [lostRunError, setLostRunError] = useState<{ task: CodesAiRunTask; message: string } | null>(null);

  const renderedProjectIdRef = useRef(projectId);
  const renderedSessionKeyRef = useRef(sessionKey);
  const generationRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const latestStartRequestRef = useRef(0);
  const latestSnapshotRequestRef = useRef(0);
  const runRef = useRef<CodesAiRunSnapshot | null>(null);
  const startingTaskRef = useRef<CodesAiRunTask | null>(null);
  const cancellationPendingRef = useRef(false);
  const completedRunIdsRef = useRef(new Set<string>());
  const onCompletedRef = useRef(onCompleted);
  const onFailedRef = useRef(onFailed);

  onCompletedRef.current = onCompleted;
  onFailedRef.current = onFailed;

  if (renderedProjectIdRef.current !== projectId || renderedSessionKeyRef.current !== sessionKey) {
    renderedProjectIdRef.current = projectId;
    renderedSessionKeyRef.current = sessionKey;
    generationRef.current += 1;
    latestStartRequestRef.current = ++requestSequenceRef.current;
    latestSnapshotRequestRef.current = requestSequenceRef.current;
    runRef.current = null;
    startingTaskRef.current = null;
    cancellationPendingRef.current = false;
  }

  useEffect(() => {
    setRun(null);
    setStartingTask(null);
    setCancellationPending(false);
    setReconnectingMessage("");
    setLostRunError(null);
    completedRunIdsRef.current.clear();
  }, [projectId, sessionKey]);

  useEffect(() => () => {
    generationRef.current += 1;
    latestStartRequestRef.current = ++requestSequenceRef.current;
    latestSnapshotRequestRef.current = requestSequenceRef.current;
  }, []);

  const applyAcceptedSnapshot = useCallback((
    snapshot: CodesAiRunSnapshot,
    expected: SnapshotExpectation
  ) => {
    const current = runRef.current;
    if (
      expected.generation !== generationRef.current
      || expected.requestId !== latestSnapshotRequestRef.current
      || renderedProjectIdRef.current !== expected.projectId
      || renderedSessionKeyRef.current !== expected.sessionKey
      || snapshot.project_id !== expected.projectId
      || snapshot.run_id !== expected.runId
      || snapshot.task !== expected.task
      || !current
      || current.project_id !== expected.projectId
      || current.run_id !== expected.runId
      || current.task !== expected.task
      || !isSnapshotProgressionAllowed(current.status, snapshot.status)
    ) {
      return false;
    }

    runRef.current = snapshot;
    setRun(snapshot);
    setReconnectingMessage("");
    setLostRunError(null);

    if (snapshot.status === "completed" && !completedRunIdsRef.current.has(snapshot.run_id)) {
      completedRunIdsRef.current.add(snapshot.run_id);
      onCompletedRef.current(snapshot);
    } else if (snapshot.status === "failed") {
      onFailedRef.current(snapshot);
    }
    return true;
  }, []);

  const pollingProjectId = run?.project_id ?? "";
  const pollingRunId = run?.run_id ?? "";
  const pollingTask = run?.task ?? null;
  const pollingStatus = run?.status ?? null;
  const pollingActive = Boolean(pollingStatus && CODES_AI_ACTIVE_STATUSES.has(pollingStatus));

  useEffect(() => {
    if (!pollingActive || !pollingProjectId || !pollingRunId || !pollingTask || cancellationPending) return;

    const expectedProjectId = pollingProjectId;
    const expectedSessionKey = renderedSessionKeyRef.current;
    const expectedRunId = pollingRunId;
    const expectedTask = pollingTask;
    const expectedGeneration = generationRef.current;
    let disposed = false;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      if (!disposed) timer = window.setTimeout(poll, delay);
    };

    const poll = async () => {
      const current = runRef.current;
      if (
        disposed
        || cancellationPendingRef.current
        || !current
        || current.project_id !== expectedProjectId
        || current.run_id !== expectedRunId
        || current.task !== expectedTask
        || !CODES_AI_ACTIVE_STATUSES.has(current.status)
      ) return;

      const requestId = ++requestSequenceRef.current;
      latestSnapshotRequestRef.current = requestId;
      const expectation = {
        projectId: expectedProjectId,
        sessionKey: expectedSessionKey,
        runId: expectedRunId,
        task: expectedTask,
        generation: expectedGeneration,
        requestId
      };

      try {
        const snapshot = await fetchCodesAiRun(expectedProjectId, expectedRunId);
        if (disposed) return;
        applyAcceptedSnapshot(snapshot, expectation);
        if (
          requestId === latestSnapshotRequestRef.current
          && expectedGeneration === generationRef.current
          && runRef.current
          && CODES_AI_ACTIVE_STATUSES.has(runRef.current.status)
        ) {
          schedule(1000);
        }
      } catch (error) {
        if (
          disposed
          || requestId !== latestSnapshotRequestRef.current
          || expectedGeneration !== generationRef.current
          || renderedProjectIdRef.current !== expectedProjectId
          || renderedSessionKeyRef.current !== expectedSessionKey
        ) return;

        if (error instanceof ApiError && error.errorCode === "ai_run_not_found") {
          runRef.current = null;
          setRun(null);
          setReconnectingMessage("");
          setLostRunError({ task: expectedTask, message: LOST_RUN_MESSAGE });
          return;
        }

        setReconnectingMessage(RECONNECTING_MESSAGE);
        schedule(1500);
      }
    };

    schedule(650);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [applyAcceptedSnapshot, cancellationPending, pollingActive, pollingProjectId, pollingRunId, pollingTask]);

  const start = useCallback(async (
    expectedTask: CodesAiRunTask,
    preparePayload: PrepareCodesAiRunStartPayload
  ): Promise<CodesAiRunMutationPayload | null> => {
    if (
      !renderedProjectIdRef.current
      || startingTaskRef.current
      || cancellationPendingRef.current
      || (runRef.current && CODES_AI_ACTIVE_STATUSES.has(runRef.current.status))
    ) return null;

    const expectedProjectId = renderedProjectIdRef.current;
    const expectedSessionKey = renderedSessionKeyRef.current;
    const expectedGeneration = generationRef.current;
    const requestId = ++requestSequenceRef.current;
    const requestIsCurrent = () => (
      requestId === latestStartRequestRef.current
      && expectedGeneration === generationRef.current
      && renderedProjectIdRef.current === expectedProjectId
      && renderedSessionKeyRef.current === expectedSessionKey
      && startingTaskRef.current === expectedTask
    );
    latestStartRequestRef.current = requestId;
    startingTaskRef.current = expectedTask;
    setStartingTask(expectedTask);
    setLostRunError(null);
    setReconnectingMessage("");
    runRef.current = null;
    setRun(null);

    try {
      const prepared = await preparePayload();
      if (!requestIsCurrent() || !prepared) return null;
      const captured = captureStartPayload(prepared);
      if (captured.project.project_id !== expectedProjectId || captured.task !== expectedTask) {
        throw new Error("The prepared AI run no longer matches the active project and task.");
      }
      const result = await startCodesAiRun(captured);
      if (
        !requestIsCurrent()
        || result.run.project_id !== expectedProjectId
        || result.run.task !== expectedTask
        || !result.run.run_id
      ) return null;

      startingTaskRef.current = null;
      setStartingTask(null);
      runRef.current = result.run;
      setRun(result.run);
      latestSnapshotRequestRef.current = ++requestSequenceRef.current;
      if (result.run.status === "completed" && !completedRunIdsRef.current.has(result.run.run_id)) {
        completedRunIdsRef.current.add(result.run.run_id);
        onCompletedRef.current(result.run);
      } else if (result.run.status === "failed") {
        onFailedRef.current(result.run);
      }
      return result;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      throw error;
    } finally {
      if (requestIsCurrent()) {
        startingTaskRef.current = null;
        setStartingTask(null);
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    const current = runRef.current;
    if (
      !current
      || !CODES_AI_ACTIVE_STATUSES.has(current.status)
      || current.status === "cancelling"
      || cancellationPendingRef.current
    ) return false;

    const expectedProjectId = current.project_id;
    const expectedSessionKey = renderedSessionKeyRef.current;
    const expectedRunId = current.run_id;
    const expectedTask = current.task;
    const expectedGeneration = generationRef.current;
    const requestId = ++requestSequenceRef.current;
    const requestIsCurrent = () => {
      const active = runRef.current;
      return requestId === latestSnapshotRequestRef.current
        && expectedGeneration === generationRef.current
        && renderedProjectIdRef.current === expectedProjectId
        && renderedSessionKeyRef.current === expectedSessionKey
        && cancellationPendingRef.current
        && active?.project_id === expectedProjectId
        && active.run_id === expectedRunId
        && active.task === expectedTask;
    };
    latestSnapshotRequestRef.current = requestId;
    cancellationPendingRef.current = true;
    setCancellationPending(true);
    setLostRunError(null);

    try {
      const snapshot = await cancelCodesAiRun(expectedProjectId, expectedRunId);
      const accepted = applyAcceptedSnapshot(snapshot, {
        projectId: expectedProjectId,
        sessionKey: expectedSessionKey,
        runId: expectedRunId,
        task: expectedTask,
        generation: expectedGeneration,
        requestId
      });
      if (!accepted && requestIsCurrent()) {
        throw new Error("The local service returned an unexpected AI cancellation response.");
      }
      return accepted;
    } catch (error) {
      if (!requestIsCurrent()) return false;
      throw error;
    } finally {
      if (requestIsCurrent()) {
        cancellationPendingRef.current = false;
        setCancellationPending(false);
      }
    }
  }, [applyAcceptedSnapshot]);

  const isLocked = useCallback(() => Boolean(
    startingTaskRef.current
    || cancellationPendingRef.current
    || (runRef.current && CODES_AI_ACTIVE_STATUSES.has(runRef.current.status))
  ), []);

  const activeWork = Boolean(
    startingTask
    || cancellationPending
    || (run && CODES_AI_ACTIVE_STATUSES.has(run.status))
  );

  return {
    run,
    startingTask,
    cancellationPending,
    reconnectingMessage,
    lostRunError,
    activeWork,
    isLocked,
    start,
    cancel
  };
}
