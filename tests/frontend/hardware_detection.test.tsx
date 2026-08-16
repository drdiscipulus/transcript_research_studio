import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHardwareDetection } from "../../src/hooks/useHardwareDetection";
import type { HardwareScanSnapshot } from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  fetchHardwareStatus: vi.fn(),
  retryHardwareScan: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, ...apiMocks };
});

const system = {
  cpu_model: "Test CPU",
  physical_cores: 8,
  logical_cores: 16,
  total_ram_gb: 32,
  gpu_model: "NVIDIA GeForce RTX 5090",
  vram_gb: 31.8,
  has_supported_nvidia_gpu: true,
  runtime_variant: "windows-gpu"
};

const checking: HardwareScanSnapshot = {
  generation: 1,
  status: "checking",
  phase: "transcription_acceleration",
  message: "Checking CUDA runtime...",
  system,
  hardware: null,
  retryable: false
};

const ready: HardwareScanSnapshot = {
  ...checking,
  status: "ready",
  phase: "ready",
  message: "Hardware detection complete.",
  hardware: {
    ...system,
    cuda_available: true,
    asr_cuda_available: true,
    pyannote_available: true,
    pyannote_cuda_available: true,
    acceleration_path: "NVIDIA / CUDA"
  }
};

const failed: HardwareScanSnapshot = {
  ...checking,
  status: "failed",
  phase: "failed",
  message: "Hardware detection failed. CPU processing remains available.",
  hardware: null,
  retryable: true
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useHardwareDetection", () => {
  beforeEach(() => {
    apiMocks.fetchHardwareStatus.mockReset();
    apiMocks.retryHardwareScan.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls phased snapshots without overlapping requests and stops when ready", async () => {
    vi.useFakeTimers();
    const first = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ready);
    const { result } = renderHook(() => useHardwareDetection());

    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(checking); await first.promise; });
    expect(result.current.snapshot.system?.gpu_model).toBe("NVIDIA GeForce RTX 5090");
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot.status).toBe("ready");

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(2);
  });

  it("suppresses an older response after a sidecar lifecycle refresh", async () => {
    const older = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(ready);
    const { result } = renderHook(() => useHardwareDetection());
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.snapshot.status).toBe("ready"));
    older.resolve(failed);
    await act(async () => { await older.promise; });

    expect(result.current.snapshot.status).toBe("ready");
    expect(result.current.requestError).toBeNull();
  });

  it("retries only a failed scan and begins polling the new generation", async () => {
    vi.useFakeTimers();
    apiMocks.fetchHardwareStatus
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(ready);
    apiMocks.retryHardwareScan.mockResolvedValue({
      ...checking,
      generation: 2,
      retry_started: true
    });
    const { result } = renderHook(() => useHardwareDetection());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.snapshot.status).toBe("failed");

    await act(async () => expect(await result.current.retry()).toBe(true));
    expect(apiMocks.retryHardwareScan).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.status).toBe("checking");

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(result.current.snapshot.status).toBe("ready");
  });

  it("preserves the failed snapshot after a rejected retry and allows a later retry", async () => {
    vi.useFakeTimers();
    apiMocks.fetchHardwareStatus
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(ready);
    apiMocks.retryHardwareScan
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce({ ...checking, generation: 2, retry_started: true });
    const { result } = renderHook(() => useHardwareDetection());
    await act(async () => { await Promise.resolve(); });

    await act(async () => expect(await result.current.retry()).toBe(false));
    expect(result.current.snapshot).toEqual(failed);
    expect(result.current.requestError).toBe(
      "Hardware scan could not be restarted. CPU processing remains available."
    );

    await act(async () => expect(await result.current.retry()).toBe(true));
    expect(result.current.requestError).toBeNull();
    expect(result.current.snapshot.status).toBe("checking");
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(result.current.snapshot.status).toBe("ready");
  });

  it("blocks duplicate retry admission within the same render batch", async () => {
    const pendingRetry = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus.mockResolvedValue(failed);
    apiMocks.retryHardwareScan.mockReturnValue(pendingRetry.promise);
    const { result } = renderHook(() => useHardwareDetection());
    await waitFor(() => expect(result.current.snapshot.status).toBe("failed"));

    let firstRetry!: Promise<boolean>;
    let secondRetry!: Promise<boolean>;
    act(() => {
      firstRetry = result.current.retry();
      secondRetry = result.current.retry();
    });
    await expect(secondRetry).resolves.toBe(false);
    expect(apiMocks.retryHardwareScan).toHaveBeenCalledTimes(1);

    pendingRetry.resolve({ ...checking, generation: 2, retry_started: true });
    await act(async () => expect(await firstRetry).toBe(true));
  });

  it("suppresses a rejected retry after refresh replaces its lifecycle", async () => {
    const pendingRetry = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(ready);
    apiMocks.retryHardwareScan.mockReturnValue(pendingRetry.promise);
    const { result } = renderHook(() => useHardwareDetection());
    await waitFor(() => expect(result.current.snapshot.status).toBe("failed"));

    let retryResult!: Promise<boolean>;
    act(() => { retryResult = result.current.retry(); });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.snapshot.status).toBe("ready"));
    pendingRetry.reject(new Error("stale retry failure"));
    await act(async () => expect(await retryResult).toBe(false));

    expect(result.current.snapshot.status).toBe("ready");
    expect(result.current.requestError).toBeNull();
  });

  it("does not publish a rejected retry after unmount", async () => {
    const pendingRetry = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus.mockResolvedValue(failed);
    apiMocks.retryHardwareScan.mockReturnValue(pendingRetry.promise);
    const rendered = renderHook(() => useHardwareDetection());
    await waitFor(() => expect(rendered.result.current.snapshot.status).toBe("failed"));

    let retryResult!: Promise<boolean>;
    act(() => { retryResult = rendered.result.current.retry(); });
    rendered.unmount();
    pendingRetry.reject(new Error("unmounted retry failure"));
    await expect(retryResult).resolves.toBe(false);
  });

  it("keeps the newest StrictMode lifecycle authoritative", async () => {
    const older = deferred<HardwareScanSnapshot>();
    const current = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useHardwareDetection(), { wrapper: StrictMode });
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(2);

    current.resolve(ready);
    await act(async () => { await current.promise; });
    expect(result.current.snapshot.status).toBe("ready");
    older.resolve(failed);
    await act(async () => { await older.promise; });

    expect(result.current.snapshot.status).toBe("ready");
    expect(result.current.requestError).toBeNull();
  });

  it("cleans StrictMode polling timers on unmount", async () => {
    vi.useFakeTimers();
    apiMocks.fetchHardwareStatus.mockResolvedValue(checking);
    const rendered = renderHook(() => useHardwareDetection(), { wrapper: StrictMode });
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(1);

    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps a retained refresh inert after genuine unmount", async () => {
    vi.useFakeTimers();
    apiMocks.fetchHardwareStatus.mockResolvedValue(ready);
    const rendered = renderHook(() => useHardwareDetection());
    await act(async () => { await Promise.resolve(); });
    expect(rendered.result.current.snapshot.status).toBe("ready");
    const retainedRefresh = rendered.result.current.refresh;

    rendered.unmount();
    act(() => retainedRefresh());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.retryHardwareScan).not.toHaveBeenCalled();
    expect(rendered.result.current.snapshot.status).toBe("ready");
    expect(rendered.result.current.requestError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a retained retry inert after genuine unmount", async () => {
    vi.useFakeTimers();
    apiMocks.fetchHardwareStatus.mockResolvedValue(failed);
    const rendered = renderHook(() => useHardwareDetection());
    await act(async () => { await Promise.resolve(); });
    expect(rendered.result.current.snapshot.status).toBe("failed");
    const retainedRetry = rendered.result.current.retry;

    rendered.unmount();
    await expect(retainedRetry()).resolves.toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(apiMocks.retryHardwareScan).not.toHaveBeenCalled();
    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.snapshot).toEqual(failed);
    expect(rendered.result.current.requestError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores request completions after unmount", async () => {
    const pending = deferred<HardwareScanSnapshot>();
    apiMocks.fetchHardwareStatus.mockReturnValue(pending.promise);
    const rendered = renderHook(() => useHardwareDetection());
    rendered.unmount();
    pending.resolve(ready);
    await pending.promise;

    expect(apiMocks.fetchHardwareStatus).toHaveBeenCalledTimes(1);
  });
});
