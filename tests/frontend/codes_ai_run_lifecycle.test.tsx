import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodesAiRunLifecycle } from "../../src/hooks/useCodesAiRunLifecycle";
import {
  ApiError,
  type CodesAiRunMutationPayload,
  type CodesAiRunSnapshot,
  type CodesAiRunStartPayload,
  type CodesProject,
  type CodesProjectHandle
} from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  start: vi.fn(),
  fetch: vi.fn(),
  cancel: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    startCodesAiRun: apiMocks.start,
    fetchCodesAiRun: apiMocks.fetch,
    cancelCodesAiRun: apiMocks.cancel
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeProject(projectId = "project_a") {
  return {
    project_id: projectId,
    name: "Study",
    ai_settings: {
      provider_id: "lmstudio",
      model_id: "local-model",
      temperature: 0,
      timeout_seconds: 180
    }
  } as CodesProject;
}

function makeHandle(projectId = "project_a"): CodesProjectHandle {
  return {
    project_file: `D:\\research\\${projectId}.evidence.json`,
    project_id: projectId,
    revision: "a".repeat(64)
  };
}

function makeRun(overrides: Partial<CodesAiRunSnapshot> = {}): CodesAiRunSnapshot {
  return {
    run_id: "run_a",
    project_id: "project_a",
    task: "codes",
    status: "running",
    phase: "requesting",
    progress_kind: "indeterminate",
    progress_label: "Waiting for LM Studio.",
    message: "Waiting for LM Studio.",
    progress_completed: 0,
    progress_total: 1,
    results: [],
    omitted: [],
    error: "",
    started_at: "2026-08-05T10:00:00Z",
    finished_at: null,
    ...overrides
  };
}

function startPayload(projectId = "project_a"): CodesAiRunStartPayload {
  return {
    project: makeProject(projectId),
    handle: makeHandle(projectId),
    task: "codes",
    researcher_prompt: "Suggest codes."
  };
}

function prepareStartPayload(payload = startPayload()) {
  return async () => payload;
}

function startResult(run = makeRun()): CodesAiRunMutationPayload {
  const project = makeProject(run.project_id);
  const handle = makeHandle(run.project_id);
  return { ...handle, project, handle, run };
}

function renderLifecycle(projectId = "project_a", sessionKey = projectId) {
  const onCompleted = vi.fn();
  const onFailed = vi.fn();
  const hook = renderHook(
    ({ currentProjectId, currentSessionKey }: { currentProjectId: string; currentSessionKey?: string }) => useCodesAiRunLifecycle({
      projectId: currentProjectId,
      sessionKey: currentSessionKey,
      onCompleted,
      onFailed
    }),
    { initialProps: { currentProjectId: projectId, currentSessionKey: sessionKey } as { currentProjectId: string; currentSessionKey?: string } }
  );
  return { ...hook, onCompleted, onFailed };
}

describe("Codes AI run lifecycle", () => {
  beforeEach(() => {
    apiMocks.start.mockReset();
    apiMocks.fetch.mockReset();
    apiMocks.cancel.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks immediately during a pending start and rejects a duplicate start", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const { result } = renderLifecycle();
    let first!: Promise<CodesAiRunMutationPayload | null>;

    act(() => {
      first = result.current.start("codes", prepareStartPayload());
    });

    expect(result.current.startingTask).toBe("codes");
    expect(result.current.activeWork).toBe(true);
    expect(result.current.isLocked()).toBe(true);
    await expect(result.current.start("codes", prepareStartPayload())).resolves.toBeNull();
    expect(apiMocks.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(startResult());
      await first;
    });
    expect(result.current.startingTask).toBeNull();
    expect(result.current.run?.status).toBe("running");
  });

  it("clears a failed pending start and allows a retry", async () => {
    apiMocks.start
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValueOnce(startResult());
    const { result } = renderLifecycle();

    await act(async () => {
      await expect(result.current.start("codes", prepareStartPayload())).rejects.toThrow("start failed");
    });
    expect(result.current.startingTask).toBeNull();
    expect(result.current.activeWork).toBe(false);
    expect(result.current.isLocked()).toBe(false);

    await act(async () => {
      await expect(result.current.start("codes", prepareStartPayload())).resolves.toEqual(expect.objectContaining({ run: expect.any(Object) }));
    });
    expect(result.current.run?.status).toBe("running");
    expect(apiMocks.start).toHaveBeenCalledTimes(2);
  });

  it("keeps an accepted cancellation snapshot when an older poll resolves", async () => {
    vi.useFakeTimers();
    apiMocks.start.mockResolvedValue(startResult());
    const pendingPoll = deferred<CodesAiRunSnapshot>();
    apiMocks.fetch.mockReturnValueOnce(pendingPoll.promise);
    apiMocks.cancel.mockResolvedValue(makeRun({ status: "cancelling", progress_label: "Cancelling…" }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(apiMocks.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.run?.status).toBe("cancelling");

    await act(async () => {
      pendingPoll.resolve(makeRun({ status: "running", progress_label: "Stale progress" }));
      await pendingPoll.promise;
    });
    expect(result.current.run?.status).toBe("cancelling");
    expect(result.current.run?.progress_label).toBe("Cancelling…");
  });

  it("rejects a newer regressive status while continuing to poll", async () => {
    vi.useFakeTimers();
    apiMocks.start.mockResolvedValue(startResult(makeRun({ status: "cancelling" })));
    apiMocks.fetch
      .mockResolvedValueOnce(makeRun({ status: "running", progress_label: "Regressive" }))
      .mockResolvedValueOnce(makeRun({ status: "cancelled", phase: "cancelled", finished_at: "2026-08-05T10:01:00Z" }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(result.current.run?.status).toBe("cancelling");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.run?.status).toBe("cancelled");
    expect(result.current.activeWork).toBe(false);
  });

  it("retries a transient polling failure without discarding the last snapshot", async () => {
    vi.useFakeTimers();
    apiMocks.start.mockResolvedValue(startResult());
    apiMocks.fetch
      .mockRejectedValueOnce(new Error("temporary disconnect"))
      .mockResolvedValueOnce(makeRun({ progress_label: "Recovered progress" }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(result.current.run?.status).toBe("running");
    expect(result.current.reconnectingMessage).toMatch(/Reconnecting/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.run?.progress_label).toBe("Recovered progress");
    expect(result.current.reconnectingMessage).toBe("");
  });

  it("stops a run that the restarted local service no longer knows", async () => {
    vi.useFakeTimers();
    apiMocks.start.mockResolvedValue(startResult());
    apiMocks.fetch.mockRejectedValue(new ApiError({
      message: "Not found",
      kind: "http",
      status: 400,
      errorCode: "ai_run_not_found"
    }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });

    expect(result.current.run).toBeNull();
    expect(result.current.activeWork).toBe(false);
    expect(result.current.lostRunError).toEqual(expect.objectContaining({ task: "codes" }));
    expect(apiMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the run after cancellation failure and accepts a retry", async () => {
    apiMocks.start.mockResolvedValue(startResult());
    apiMocks.cancel
      .mockRejectedValueOnce(new Error("cancel failed"))
      .mockResolvedValueOnce(makeRun({ status: "cancelling" }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await expect(result.current.cancel()).rejects.toThrow("cancel failed");
    });
    expect(result.current.run?.status).toBe("running");
    expect(result.current.cancellationPending).toBe(false);

    await act(async () => {
      await expect(result.current.cancel()).resolves.toBe(true);
    });
    expect(result.current.run?.status).toBe("cancelling");
    expect(apiMocks.cancel).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["project", { project_id: "project_b" }],
    ["run", { run_id: "run_b" }],
    ["task", { task: "note" as const }]
  ])("ignores a cancellation response for another %s", async (_mismatch, overrides) => {
    apiMocks.start.mockResolvedValue(startResult());
    apiMocks.cancel.mockResolvedValue(makeRun({ ...overrides, status: "cancelling" }));
    const { result } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await expect(result.current.cancel()).rejects.toThrow(/unexpected AI cancellation response/);
    });
    expect(result.current.run?.project_id).toBe("project_a");
    expect(result.current.run?.run_id).toBe("run_a");
    expect(result.current.run?.task).toBe("codes");
    expect(result.current.run?.status).toBe("running");
  });

  it("applies completion once and never lets an older request regress it", async () => {
    vi.useFakeTimers();
    apiMocks.start.mockResolvedValue(startResult());
    const stalePoll = deferred<CodesAiRunSnapshot>();
    apiMocks.fetch.mockReturnValueOnce(stalePoll.promise);
    apiMocks.cancel.mockResolvedValue(makeRun({
      status: "completed",
      phase: "completed",
      results: [],
      finished_at: "2026-08-05T10:01:00Z"
    }));
    const { result, onCompleted } = renderLifecycle();

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
      await vi.advanceTimersByTimeAsync(650);
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.run?.status).toBe("completed");
    expect(result.current.activeWork).toBe(false);
    expect(onCompleted).toHaveBeenCalledTimes(1);

    await act(async () => {
      stalePoll.resolve(makeRun({ status: "running" }));
      await stalePoll.promise;
    });
    expect(result.current.run?.status).toBe("completed");
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("invalidates a pending start when the project is replaced", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const { result, rerender, onCompleted } = renderLifecycle();
    let startRequest!: Promise<CodesAiRunMutationPayload | null>;

    act(() => {
      startRequest = result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.start).toHaveBeenCalledTimes(1);
    rerender({ currentProjectId: "project_b" });

    await act(async () => {
      pending.resolve(startResult());
      await expect(startRequest).resolves.toBeNull();
    });
    expect(result.current.run).toBeNull();
    expect(result.current.activeWork).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("suppresses a pending start rejection after the project is replaced", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const { result, rerender, onCompleted, onFailed } = renderLifecycle();
    let startRequest!: Promise<CodesAiRunMutationPayload | null>;

    act(() => {
      startRequest = result.current.start("codes", prepareStartPayload());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.start).toHaveBeenCalledTimes(1);
    rerender({ currentProjectId: "project_b" });

    await act(async () => {
      pending.reject(new Error("stale start failure"));
      await expect(startRequest).resolves.toBeNull();
    });
    expect(result.current.run).toBeNull();
    expect(result.current.activeWork).toBe(false);
    expect(result.current.isLocked()).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("invalidates a pending start when the project file changes within the same project", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const { result, rerender, onCompleted } = renderLifecycle("project_a", "project_a\0first.evidence.json");
    let startRequest!: Promise<CodesAiRunMutationPayload | null>;

    act(() => {
      startRequest = result.current.start("codes", prepareStartPayload());
    });
    await vi.waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));
    rerender({ currentProjectId: "project_a", currentSessionKey: "project_a\0saved-as.evidence.json" });

    await act(async () => {
      pending.resolve(startResult(makeRun({ status: "completed", phase: "completed" })));
      await expect(startRequest).resolves.toBeNull();
    });
    expect(onCompleted).not.toHaveBeenCalled();
    expect(result.current.run).toBeNull();
  });

  it("suppresses a pending start rejection after the project file changes", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const { result, rerender, onCompleted, onFailed } = renderLifecycle("project_a", "project_a\0first.evidence.json");
    let startRequest!: Promise<CodesAiRunMutationPayload | null>;

    act(() => {
      startRequest = result.current.start("codes", prepareStartPayload());
    });
    await vi.waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));
    rerender({ currentProjectId: "project_a", currentSessionKey: "project_a\0saved-as.evidence.json" });

    await act(async () => {
      pending.reject(new Error("stale start failure"));
      await expect(startRequest).resolves.toBeNull();
    });
    expect(result.current.run).toBeNull();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("suppresses a pending cancellation after the project file changes", async () => {
    apiMocks.start.mockResolvedValue(startResult());
    const pending = deferred<CodesAiRunSnapshot>();
    apiMocks.cancel.mockReturnValue(pending.promise);
    const { result, rerender } = renderLifecycle("project_a", "project_a\0first.evidence.json");
    let cancellation!: Promise<boolean>;

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    act(() => {
      cancellation = result.current.cancel();
    });
    rerender({ currentProjectId: "project_a", currentSessionKey: "project_a\0saved-as.evidence.json" });
    await act(async () => {
      pending.resolve(makeRun({ status: "cancelling" }));
      await expect(cancellation).resolves.toBe(false);
    });
    expect(result.current.run).toBeNull();
    expect(result.current.isLocked()).toBe(false);
  });

  it("suppresses a pending cancellation rejection after the project is replaced", async () => {
    apiMocks.start.mockResolvedValue(startResult());
    const pendingCancellation = deferred<CodesAiRunSnapshot>();
    apiMocks.cancel.mockReturnValue(pendingCancellation.promise);
    const { result, rerender, onCompleted, onFailed } = renderLifecycle();
    let cancellationRequest!: Promise<boolean>;

    await act(async () => {
      await result.current.start("codes", prepareStartPayload());
    });
    act(() => {
      cancellationRequest = result.current.cancel();
    });
    rerender({ currentProjectId: "project_b" });

    await act(async () => {
      pendingCancellation.reject(new Error("stale cancellation failure"));
      await expect(cancellationRequest).resolves.toBe(false);
    });
    expect(result.current.run).toBeNull();
    expect(result.current.activeWork).toBe(false);
    expect(result.current.isLocked()).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
