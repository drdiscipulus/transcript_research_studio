import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTranscriptionRunLifecycle } from "../../src/hooks/useTranscriptionRunLifecycle";
import type { BackendHealth, BatchRunSnapshot } from "../../src/lib/api";
import type { TranscriptionOperationAccess } from "../../src/lib/transcriptionWorkspaceContracts";

const apiMocks = vi.hoisted(() => ({
  cancelBatch: vi.fn(),
  fetchBackendHealth: vi.fn(),
  fetchCurrentBatch: vi.fn(),
  startBatch: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, ...apiMocks };
});

const health: BackendHealth = {
  bind: "127.0.0.1",
  environment: "test",
  status: "ready",
  instance_id: "sidecar-a",
  started_at: "2026-08-06T10:00:00Z"
};

function batch(
  status: string,
  batchId: string | null = "batch-a",
  overrides: Partial<BatchRunSnapshot> = {}
): BatchRunSnapshot {
  return {
    batch_id: batchId,
    batch_name: batchId,
    status,
    message: status,
    progress_percent: status === "completed" ? 100 : 25,
    files_completed: status === "completed" ? 1 : 0,
    total_files: batchId ? 1 : 0,
    current_file_name: status === "running" ? "interview.wav" : null,
    started_at: batchId ? "2026-08-06T10:00:00Z" : null,
    finished_at: status === "completed" ? "2026-08-06T10:01:00Z" : null,
    output_files: [],
    files: [],
    counts: {},
    log_file: null,
    warnings: [],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function operationCoordinator(): TranscriptionOperationAccess {
  let activeToken: number | null = null;
  let nextToken = 0;
  return {
    acquire: () => {
      if (activeToken !== null) return null;
      activeToken = ++nextToken;
      return activeToken;
    },
    release: (token) => {
      if (activeToken === token) activeToken = null;
    }
  };
}

const startRequest = () => ({
  workspaceGeneration: 0,
  payload: {
    input_source_type: "single_file",
    input_path: "C:\\research\\interview.wav",
    transcript_output_folder: "C:\\research\\outputs",
    output_organization: "separate_files" as const,
    output_naming_mode: "input_filename",
    output_basename: "",
    language: "auto",
    output_mode: "transcribe",
    export_formats: ["xlsx"],
    transcript_layout: "file",
    paragraph_options: { paragraph_pause_enabled: true, max_pause_seconds: 3 },
    model_name: "small",
    acceleration: "cpu"
  }
});

function renderLifecycle() {
  const operation = operationCoordinator();
  return renderHook(() => useTranscriptionRunLifecycle({
    operation,
    getWorkspaceGeneration: () => 0
  }));
}

describe("useTranscriptionRunLifecycle", () => {
  beforeEach(() => {
    apiMocks.cancelBatch.mockReset();
    apiMocks.fetchBackendHealth.mockReset().mockResolvedValue(health);
    apiMocks.fetchCurrentBatch.mockReset().mockResolvedValue(batch("idle", null));
    apiMocks.startBatch.mockReset();
  });

  it("rejects rapid duplicate starts before React rerenders", async () => {
    const response = deferred<BatchRunSnapshot>();
    apiMocks.startBatch.mockReturnValue(response.promise);
    const { result } = renderLifecycle();

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.actions.start(startRequest);
      second = result.current.actions.start(startRequest);
    });

    await expect(second).resolves.toBe(false);
    expect(apiMocks.startBatch).toHaveBeenCalledTimes(1);
    expect(result.current.refs.isConfigurationLocked()).toBe(true);

    response.resolve(batch("running"));
    await act(async () => expect(await first).toBe(true));
    expect(result.current.state.liveBatch?.status).toBe("running");
  });

  it("accepts a new start after a retained terminal run", async () => {
    apiMocks.startBatch
      .mockResolvedValueOnce(batch("completed", "batch-old"))
      .mockResolvedValueOnce(batch("running", "batch-new"));
    const { result } = renderLifecycle();

    await act(async () => expect(await result.current.actions.start(startRequest)).toBe(true));
    expect(result.current.state.liveBatch?.batch_id).toBe("batch-old");
    await act(async () => expect(await result.current.actions.start(startRequest)).toBe(true));
    expect(result.current.state.liveBatch?.batch_id).toBe("batch-new");
    expect(result.current.state.liveBatch?.status).toBe("running");
  });

  it("ignores an idle poll issued before a new start", async () => {
    const oldPoll = deferred<BatchRunSnapshot>();
    apiMocks.fetchCurrentBatch.mockReturnValueOnce(oldPoll.promise);
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-new"));
    const { result } = renderLifecycle();

    await waitFor(() => expect(apiMocks.fetchCurrentBatch).toHaveBeenCalledTimes(1));
    await act(async () => expect(await result.current.actions.start(startRequest)).toBe(true));
    oldPoll.resolve(batch("idle", null));
    await act(async () => { await oldPoll.promise; });

    expect(result.current.state.liveBatch?.batch_id).toBe("batch-new");
    expect(result.current.state.liveBatch?.status).toBe("running");
  });

  it("lets terminal polling beat an older cancellation response", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("running"));
    const cancellation = deferred<BatchRunSnapshot>();
    apiMocks.cancelBatch.mockReturnValue(cancellation.promise);
    const { result } = renderLifecycle();

    await act(async () => { await result.current.actions.start(startRequest); });
    let opened = false;
    act(() => { opened = result.current.actions.requestCancellation(); });
    expect(opened).toBe(true);
    const requestKey = result.current.state.cancelDialog.requestKey;
    let cancellationResult!: Promise<boolean>;
    act(() => { cancellationResult = result.current.actions.confirmCancellation(requestKey); });
    expect(result.current.state.cancellationPending).toBe(true);

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("completed"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("completed"));
    cancellation.resolve(batch("cancelling"));
    await act(async () => expect(await cancellationResult).toBe(false));

    expect(result.current.state.liveBatch?.status).toBe("completed");
    expect(result.current.state.cancellationPending).toBe(false);
    expect(result.current.state.cancellationError).toBeNull();
  });

  it("accepts cancelling after a later-issued stale running poll", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("running"));
    const cancellation = deferred<BatchRunSnapshot>();
    const stalePoll = deferred<BatchRunSnapshot>();
    apiMocks.cancelBatch.mockReturnValue(cancellation.promise);
    const { result } = renderLifecycle();

    await act(async () => { await result.current.actions.start(startRequest); });
    act(() => { result.current.actions.requestCancellation(); });
    let cancellationResult!: Promise<boolean>;
    act(() => {
      cancellationResult = result.current.actions.confirmCancellation(
        result.current.state.cancelDialog.requestKey
      );
    });

    const pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockReturnValueOnce(stalePoll.promise);
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    stalePoll.resolve(batch("running", "batch-a", { message: "Later stale running snapshot" }));
    await act(async () => { await stalePoll.promise; });
    expect(result.current.state.liveBatch?.message).toBe("Later stale running snapshot");

    cancellation.resolve(batch("cancelling"));
    await act(async () => expect(await cancellationResult).toBe(true));
    expect(result.current.state.liveBatch?.status).toBe("cancelling");
  });

  it("keeps the later same-status snapshot over an older start response", async () => {
    const startResponse = deferred<BatchRunSnapshot>();
    apiMocks.startBatch.mockReturnValue(startResponse.promise);
    const { result } = renderLifecycle();

    let startResult!: Promise<boolean>;
    act(() => { startResult = result.current.actions.start(startRequest); });
    const pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-a", {
      message: "Newer progress",
      progress_percent: 60
    }));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    await waitFor(() => expect(result.current.state.liveBatch?.message).toBe("Newer progress"));

    startResponse.resolve(batch("running", "batch-a", {
      message: "Older progress",
      progress_percent: 10
    }));
    await act(async () => expect(await startResult).toBe(false));
    expect(result.current.state.liveBatch?.message).toBe("Newer progress");
    expect(result.current.state.liveBatch?.progress_percent).toBe(60);
  });

  it("accepts an older-issued terminal action after a later nonterminal poll", async () => {
    const startResponse = deferred<BatchRunSnapshot>();
    apiMocks.startBatch.mockReturnValue(startResponse.promise);
    const { result } = renderLifecycle();

    let startResult!: Promise<boolean>;
    act(() => { startResult = result.current.actions.start(startRequest); });
    const pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-a", {
      message: "Later nonterminal poll"
    }));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("running"));

    startResponse.resolve(batch("completed", "batch-a", { message: "Completed by action" }));
    await act(async () => expect(await startResult).toBe(true));
    expect(result.current.state.liveBatch?.status).toBe("completed");
    expect(result.current.state.liveBatch?.message).toBe("Completed by action");
  });

  it("closes an exact cancellation dialog when polling reaches terminal state", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("running"));
    const { result } = renderLifecycle();

    await act(async () => { await result.current.actions.start(startRequest); });
    let opened = false;
    act(() => { opened = result.current.actions.requestCancellation(); });
    expect(opened).toBe(true);
    expect(result.current.state.cancelDialog.open).toBe(true);
    const requestKey = result.current.state.cancelDialog.requestKey;

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("completed"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("completed"));
    expect(result.current.state.cancelDialog.open).toBe(false);
    await expect(result.current.actions.confirmCancellation(requestKey)).resolves.toBe(false);
    expect(apiMocks.cancelBatch).not.toHaveBeenCalled();
  });

  it("makes retained callbacks from an older dialog harmless to a newer batch", async () => {
    apiMocks.startBatch
      .mockResolvedValueOnce(batch("running", "batch-a"))
      .mockResolvedValueOnce(batch("running", "batch-b"));
    const { result } = renderLifecycle();
    await act(async () => { await result.current.actions.start(startRequest); });
    act(() => { result.current.actions.requestCancellation(); });
    const oldKey = result.current.state.cancelDialog.requestKey;
    act(() => result.current.actions.cancelCancellationDialog(oldKey));

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("completed", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("completed"));
    await act(async () => { await result.current.actions.start(startRequest); });
    act(() => { result.current.actions.requestCancellation(); });
    const newKey = result.current.state.cancelDialog.requestKey;
    expect(newKey).not.toBe(oldKey);

    await expect(result.current.actions.confirmCancellation(oldKey)).resolves.toBe(false);
    act(() => result.current.actions.cancelCancellationDialog(oldKey));
    expect(result.current.state.cancelDialog.open).toBe(true);
    expect(apiMocks.cancelBatch).not.toHaveBeenCalled();
    act(() => result.current.actions.cancelCancellationDialog(newKey));
    expect(result.current.state.cancelDialog.open).toBe(false);
  });

  it("keeps an active run after cancellation failure and permits retry", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("running"));
    apiMocks.cancelBatch
      .mockRejectedValueOnce(new Error("Cancellation request failed."))
      .mockResolvedValueOnce(batch("cancelling"));
    const { result } = renderLifecycle();

    await act(async () => { await result.current.actions.start(startRequest); });
    let opened = false;
    act(() => { opened = result.current.actions.requestCancellation(); });
    expect(opened).toBe(true);
    await act(async () => expect(
      await result.current.actions.confirmCancellation(result.current.state.cancelDialog.requestKey)
    ).toBe(false));
    expect(result.current.state.liveBatch?.status).toBe("running");
    expect(result.current.state.cancellationError).toBe("Cancellation request failed.");

    act(() => { opened = result.current.actions.requestCancellation(); });
    expect(opened).toBe(true);
    await act(async () => expect(
      await result.current.actions.confirmCancellation(result.current.state.cancelDialog.requestKey)
    ).toBe(true));
    expect(result.current.state.liveBatch?.status).toBe("cancelling");
    expect(result.current.state.cancellationError).toBeNull();
  });

  it("ignores wrong-batch and regressive snapshots for the active batch", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-a"));
    const { result } = renderLifecycle();
    await act(async () => { await result.current.actions.start(startRequest); });

    let pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-b"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    expect(result.current.state.liveBatch?.batch_id).toBe("batch-a");

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("cancelling", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("cancelling"));

    pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    expect(result.current.state.liveBatch?.status).toBe("cancelling");

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("completed", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("completed"));
    pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    expect(result.current.state.liveBatch?.status).toBe("completed");
  });

  it("marks only the exact active run interrupted after a sidecar replacement", async () => {
    const { result } = renderLifecycle();
    await waitFor(() => expect(result.current.state.pollingState.health?.instance_id).toBe("sidecar-a"));
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-a"));
    await act(async () => { await result.current.actions.start(startRequest); });

    apiMocks.fetchBackendHealth.mockResolvedValueOnce({ ...health, instance_id: "sidecar-b" });
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.status).toBe("interrupted"));
    expect(result.current.state.liveBatch?.batch_id).toBe("batch-a");
    expect(result.current.state.liveBatch?.error_code).toBe("sidecar_restarted");

    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-b"));
    await act(async () => expect(await result.current.actions.start(startRequest)).toBe(true));
    expect(result.current.state.liveBatch?.batch_id).toBe("batch-b");
  });

  it("keeps a dismissed terminal snapshot hidden while discovering genuine later work", async () => {
    apiMocks.startBatch.mockResolvedValue(batch("completed", "batch-a"));
    const { result } = renderLifecycle();
    await act(async () => { await result.current.actions.start(startRequest); });
    let reset = false;
    act(() => { reset = result.current.actions.resetForNewRun(); });
    expect(reset).toBe(true);
    expect(result.current.state.liveBatch).toBeNull();

    const pollCount = apiMocks.fetchCurrentBatch.mock.calls.length;
    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("completed", "batch-a"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(apiMocks.fetchCurrentBatch.mock.calls.length).toBeGreaterThan(pollCount));
    expect(result.current.state.liveBatch).toBeNull();

    apiMocks.fetchCurrentBatch.mockResolvedValueOnce(batch("running", "batch-b"));
    act(() => result.current.actions.retryPolling());
    await waitFor(() => expect(result.current.state.liveBatch?.batch_id).toBe("batch-b"));
  });

  it("keeps late start and cancellation completions silent after unmount", async () => {
    const startResponse = deferred<BatchRunSnapshot>();
    apiMocks.startBatch.mockReturnValueOnce(startResponse.promise).mockResolvedValue(batch("running"));
    const first = renderLifecycle();
    let startResult!: Promise<boolean>;
    act(() => { startResult = first.result.current.actions.start(startRequest); });
    const retainedStart = first.result.current.actions.start;
    first.unmount();
    startResponse.resolve(batch("running"));
    await expect(startResult).resolves.toBe(false);
    await expect(retainedStart(startRequest)).resolves.toBe(false);
    expect(apiMocks.startBatch).toHaveBeenCalledTimes(1);

    const cancellation = deferred<BatchRunSnapshot>();
    apiMocks.cancelBatch.mockReturnValue(cancellation.promise);
    const second = renderLifecycle();
    await act(async () => { await second.result.current.actions.start(startRequest); });
    act(() => { second.result.current.actions.requestCancellation(); });
    const retainedActions = second.result.current.actions;
    let cancellationResult!: Promise<boolean>;
    act(() => {
      cancellationResult = retainedActions.confirmCancellation(
        second.result.current.state.cancelDialog.requestKey
      );
    });
    second.unmount();
    cancellation.resolve(batch("cancelling"));
    await expect(cancellationResult).resolves.toBe(false);
    expect(retainedActions.requestCancellation()).toBe(false);
    await expect(retainedActions.confirmCancellation("obsolete")).resolves.toBe(false);
    expect(apiMocks.cancelBatch).toHaveBeenCalledTimes(1);
  });

  it("ignores polling and retained polling actions after unmount", async () => {
    const pendingHealth = deferred<BackendHealth>();
    apiMocks.fetchBackendHealth.mockReturnValue(pendingHealth.promise);
    const { result, unmount } = renderLifecycle();
    await waitFor(() => expect(apiMocks.fetchBackendHealth).toHaveBeenCalledTimes(1));
    const retainedRetry = result.current.actions.retryPolling;

    unmount();
    pendingHealth.resolve(health);
    await pendingHealth.promise;
    retainedRetry();
    await Promise.resolve();

    expect(apiMocks.fetchBackendHealth).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchCurrentBatch).not.toHaveBeenCalled();
  });

  it("ignores a batch snapshot that completes after unmount", async () => {
    const pendingBatch = deferred<BatchRunSnapshot>();
    apiMocks.fetchBackendHealth.mockResolvedValue(health);
    apiMocks.fetchCurrentBatch.mockReturnValue(pendingBatch.promise);
    const { result, unmount } = renderLifecycle();

    await waitFor(() => expect(apiMocks.fetchCurrentBatch).toHaveBeenCalledTimes(1));
    const retainedRetry = result.current.actions.retryPolling;
    unmount();
    pendingBatch.resolve(batch("running", "batch-late"));
    await pendingBatch.promise;
    retainedRetry();
    await Promise.resolve();

    expect(apiMocks.fetchBackendHealth).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchCurrentBatch).toHaveBeenCalledTimes(1);
  });
});
