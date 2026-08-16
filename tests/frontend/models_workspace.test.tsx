import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useModelsWorkspace } from "../../src/hooks/useModelsWorkspace";
import type { ModelsStatus } from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  fetchProgress: vi.fn(),
  testToken: vi.fn(),
  downloadPyannote: vi.fn(),
  deletePyannote: vi.fn(),
  downloadWhisper: vi.fn(),
  deleteWhisper: vi.fn(),
  openExternal: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    fetchModelsStatus: apiMocks.fetchStatus,
    fetchModelDownloadProgress: apiMocks.fetchProgress,
    testHfToken: apiMocks.testToken,
    downloadPyannoteModel: apiMocks.downloadPyannote,
    deletePyannoteModel: apiMocks.deletePyannote,
    downloadFasterWhisperModel: apiMocks.downloadWhisper,
    deleteFasterWhisperModel: apiMocks.deleteWhisper,
    openExternalUrl: apiMocks.openExternal
  };
});

const missingCatalog: ModelsStatus = {
  faster_whisper: [
    { value: "small", label: "Small", repo_id: "repo/small", installed: false, availability: "missing", missing_files: [] },
    { value: "medium", label: "Medium", repo_id: "repo/medium", installed: false, availability: "incomplete", missing_files: ["model.bin"] }
  ],
  pyannote: {
    model_id: "pyannote/speaker-diarization-community-1",
    model_url: "https://huggingface.co/pyannote/model",
    token_url: "https://huggingface.co/settings/tokens",
    model_dir: "local-model-dir",
    installed: false,
    availability: "missing",
    missing_files: ["config.yaml"]
  }
};

const readySmall = { ...missingCatalog.faster_whisper[0], installed: true, availability: "ready" as const };
const readyPyannote = { ...missingCatalog.pyannote, installed: true, availability: "ready" as const, missing_files: [] };
const readyCatalog: ModelsStatus = {
  ...missingCatalog,
  faster_whisper: [readySmall, missingCatalog.faster_whisper[1]],
  pyannote: readyPyannote
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

async function renderWorkspace(catalog: ModelsStatus = missingCatalog) {
  apiMocks.fetchStatus.mockResolvedValueOnce(catalog);
  const rendered = renderHook(() => useModelsWorkspace());
  await waitFor(() => expect(rendered.result.current.shared.modelsStatusLoading).toBe(false));
  return rendered;
}

describe("useModelsWorkspace catalog lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.fetchProgress.mockResolvedValue({ downloads: {} });
    apiMocks.openExternal.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("keeps the newest StrictMode initial catalog when an older request resolves later", async () => {
    const older = deferred<ModelsStatus>();
    apiMocks.fetchStatus.mockReturnValueOnce(older.promise).mockResolvedValueOnce(readyCatalog);
    const { result } = renderHook(() => useModelsWorkspace(), { reactStrictMode: true });

    await waitFor(() => expect(result.current.shared.modelsStatus).toEqual(readyCatalog));
    older.resolve(missingCatalog);
    await act(async () => older.promise);

    expect(result.current.shared.modelsStatus).toEqual(readyCatalog);
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("preserves a trusted catalog on refresh failure and rejects rapid duplicate refresh", async () => {
    const { result } = await renderWorkspace();
    const pending = deferred<ModelsStatus>();
    apiMocks.fetchStatus.mockReturnValueOnce(pending.promise);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.page.actions.refresh();
      second = result.current.page.actions.refresh();
    });
    await expect(second).resolves.toBe(false);
    pending.reject(new Error("offline"));
    await act(async () => first);

    expect(result.current.shared.modelsStatus).toEqual(missingCatalog);
    expect(result.current.shared.modelsStatusError).toBeNull();
    expect(result.current.page.catalog.error).toContain("could not be loaded");
  });

  it("silences a refresh after unmount and makes a retained action inert", async () => {
    const pending = deferred<ModelsStatus>();
    apiMocks.fetchStatus.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useModelsWorkspace());
    const retainedRefresh = result.current.page.actions.refresh;
    unmount();
    pending.resolve(missingCatalog);
    await act(async () => pending.promise);

    await expect(retainedRefresh()).resolves.toBe(false);
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe("useModelsWorkspace model operations", () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.fetchProgress.mockResolvedValue({ downloads: {} });
  });

  afterEach(() => vi.useRealTimers());

  it("blocks rapid duplicate and competing downloads before rerender", async () => {
    const { result } = await renderWorkspace();
    const download = deferred<{ model: typeof readySmall }>();
    apiMocks.downloadWhisper.mockReturnValueOnce(download.promise);

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    let competing!: Promise<boolean>;
    act(() => {
      first = result.current.page.actions.downloadFasterWhisper("small");
      duplicate = result.current.page.actions.downloadFasterWhisper("small");
      competing = result.current.page.actions.downloadFasterWhisper("medium");
    });
    await expect(duplicate).resolves.toBe(false);
    await expect(competing).resolves.toBe(false);
    expect(apiMocks.downloadWhisper).toHaveBeenCalledTimes(1);
    expect(result.current.shell.activeJob).toBe(true);

    apiMocks.fetchStatus.mockResolvedValueOnce(readyCatalog);
    download.resolve({ model: readySmall });
    await act(async () => first);
    expect(result.current.shell.activeJob).toBe(false);
  });

  it("patches only the returned target before adopting the authoritative follow-up refresh", async () => {
    const { result } = await renderWorkspace();
    const refresh = deferred<ModelsStatus>();
    apiMocks.downloadWhisper.mockResolvedValueOnce({ model: readySmall });
    apiMocks.fetchStatus.mockReturnValueOnce(refresh.promise);

    let operation!: Promise<boolean>;
    act(() => { operation = result.current.page.actions.downloadFasterWhisper("small"); });
    await waitFor(() => expect(result.current.shared.modelsStatus?.faster_whisper[0].availability).toBe("ready"));
    expect(result.current.shared.modelsStatus?.faster_whisper[1].availability).toBe("incomplete");

    const authoritative = {
      ...readyCatalog,
      faster_whisper: [readySmall, { ...missingCatalog.faster_whisper[1], availability: "missing" as const }]
    };
    refresh.resolve(authoritative);
    await act(async () => operation);
    expect(result.current.shared.modelsStatus).toEqual(authoritative);
  });

  it("retains a successful mutation patch when the follow-up refresh fails", async () => {
    const { result } = await renderWorkspace();
    apiMocks.downloadWhisper.mockResolvedValueOnce({ model: readySmall });
    apiMocks.fetchStatus.mockRejectedValueOnce(new Error("refresh failed"));

    await act(async () => result.current.page.actions.downloadFasterWhisper("small"));

    expect(result.current.shared.modelsStatus?.faster_whisper[0]).toEqual(readySmall);
    expect(result.current.shared.modelsStatusError).toBeNull();
    expect(result.current.page.catalog.error).toContain("changed successfully");
    expect(result.current.page.operation.message).toBe("Small model downloaded locally.");
  });

  it("retains retry capability after failure and uses the download contract for repair", async () => {
    const { result } = await renderWorkspace();
    apiMocks.downloadWhisper.mockRejectedValueOnce(new Error("failed"));
    await act(async () => result.current.page.actions.downloadFasterWhisper("medium"));
    expect(result.current.page.operation.error).toBe("Model could not be downloaded.");

    const repaired = { ...missingCatalog.faster_whisper[1], installed: true, availability: "ready" as const, missing_files: [] };
    apiMocks.downloadWhisper.mockResolvedValueOnce({ model: repaired });
    apiMocks.fetchStatus.mockResolvedValueOnce({ ...missingCatalog, faster_whisper: [missingCatalog.faster_whisper[0], repaired] });
    await act(async () => result.current.page.actions.downloadFasterWhisper("medium"));

    expect(apiMocks.downloadWhisper).toHaveBeenNthCalledWith(1, "medium");
    expect(apiMocks.downloadWhisper).toHaveBeenNthCalledWith(2, "medium");
    expect(result.current.page.operation.error).toBeNull();
  });

  it("silences a late mismatched mutation and stops its progress lifecycle after unmount", async () => {
    const { result, unmount } = await renderWorkspace();
    vi.useFakeTimers();
    const download = deferred<{ model: typeof readySmall }>();
    apiMocks.downloadWhisper.mockReturnValueOnce(download.promise);

    let operation!: Promise<boolean>;
    act(() => { operation = result.current.page.actions.downloadFasterWhisper("small"); });
    await act(async () => Promise.resolve());
    const callsBeforeUnmount = apiMocks.fetchProgress.mock.calls.length;
    const retainedDownload = result.current.page.actions.downloadFasterWhisper;
    unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(apiMocks.fetchProgress).toHaveBeenCalledTimes(callsBeforeUnmount);

    download.resolve({ model: { ...readySmall, value: "medium", label: "Medium" } });
    await expect(operation).resolves.toBe(false);
    await expect(retainedDownload("medium")).resolves.toBe(false);
    expect(apiMocks.downloadWhisper).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps the catalog unchanged and unlocks retry after a mismatched Whisper download response", async () => {
    const { result } = await renderWorkspace();
    const unexpected = { ...readySmall, value: "medium", label: "Medium" };
    apiMocks.downloadWhisper.mockResolvedValueOnce({ model: unexpected });

    await act(async () => {
      await expect(result.current.page.actions.downloadFasterWhisper("small")).resolves.toBe(false);
    });

    expect(result.current.shared.modelsStatus).toEqual(missingCatalog);
    expect(result.current.page.operation.error).toBe("The local service returned an unexpected model response. Try again.");
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
    apiMocks.downloadWhisper.mockRejectedValueOnce(new Error("retry"));
    await act(async () => {
      await expect(result.current.page.actions.downloadFasterWhisper("small")).resolves.toBe(false);
    });
    expect(apiMocks.downloadWhisper).toHaveBeenCalledTimes(2);
  });

  it("keeps the catalog unchanged and unlocks retry after a mismatched Pyannote download response", async () => {
    const { result } = await renderWorkspace();
    act(() => { result.current.page.token.setInput("synthetic-test-credential"); });
    apiMocks.downloadPyannote.mockResolvedValueOnce({ ...readyPyannote, model_id: "unexpected-model" });

    await act(async () => {
      await expect(result.current.page.actions.downloadPyannote()).resolves.toBe(false);
    });

    expect(result.current.shared.modelsStatus).toEqual(missingCatalog);
    expect(result.current.page.token.input).toBe("synthetic-test-credential");
    expect(result.current.page.operation.error).toBe("The local service returned an unexpected model response. Try again.");
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
    apiMocks.downloadPyannote.mockRejectedValueOnce(new Error("retry"));
    await act(async () => {
      await expect(result.current.page.actions.downloadPyannote()).resolves.toBe(false);
    });
    expect(apiMocks.downloadPyannote).toHaveBeenCalledTimes(2);
  });

  it("binds progress to the exact download and preserves trustworthy progress through a polling failure", async () => {
    const { result } = await renderWorkspace();
    vi.useFakeTimers();
    const download = deferred<{ model: typeof readySmall }>();
    apiMocks.downloadWhisper.mockReturnValueOnce(download.promise);
    apiMocks.fetchProgress
      .mockResolvedValueOnce({ downloads: { other: { id: "other", label: "Other", status: "running", percent: 90, downloaded_bytes: 90, total_bytes: 100, message: "Other", updated_at: "now" } } })
      .mockResolvedValueOnce({ downloads: { "fw:small": { id: "fw:small", label: "Small", status: "running", percent: 25, downloaded_bytes: 25, total_bytes: 100, message: "Downloading", updated_at: "now" } } })
      .mockRejectedValueOnce(new Error("poll failed"))
      .mockResolvedValueOnce({ downloads: { "fw:small": { id: "fw:small", label: "Small", status: "running", percent: 50, downloaded_bytes: 50, total_bytes: 100, message: "Downloading", updated_at: "later" } } });

    let operation!: Promise<boolean>;
    act(() => { operation = result.current.page.actions.downloadFasterWhisper("small"); });
    await act(async () => Promise.resolve());
    expect(result.current.page.operation.progress).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.page.operation.progress?.percent).toBe(25);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.page.operation.progress?.percent).toBe(25);
    expect(result.current.page.operation.progressWarning).toContain("stale");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.page.operation.progress?.percent).toBe(50);
    expect(result.current.page.operation.progressWarning).toBeNull();

    apiMocks.fetchStatus.mockResolvedValueOnce(readyCatalog);
    download.resolve({ model: readySmall });
    await act(async () => operation);
    expect(result.current.page.operation.progress).toBeNull();
  });
});

describe("useModelsWorkspace token, deletion, and links", () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.fetchProgress.mockResolvedValue({ downloads: {} });
    apiMocks.openExternal.mockResolvedValue(undefined);
  });

  it("binds token results to the current input generation and blocks rapid duplicate tests", async () => {
    const { result } = await renderWorkspace();
    const tokenTest = deferred<{ ok: boolean; status: string; message: string; user: null; organizations: string[] }>();
    apiMocks.testToken.mockReturnValueOnce(tokenTest.promise);
    act(() => { result.current.page.token.setInput("  temporary-value  "); });

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = result.current.page.token.test();
      duplicate = result.current.page.token.test();
    });
    await expect(duplicate).resolves.toBe(false);
    act(() => { result.current.page.token.setInput("replacement-value"); });
    tokenTest.resolve({ ok: true, status: "ok", message: "Ready", user: null, organizations: [] });
    await act(async () => first);

    expect(apiMocks.testToken).toHaveBeenCalledTimes(1);
    expect(result.current.page.token.result).toBeNull();
  });

  it("publishes only a redacted token presentation result and clears it on input change", async () => {
    const { result } = await renderWorkspace();
    const tokenValue = "synthetic-test-credential";
    act(() => { result.current.page.token.setInput(tokenValue); });
    apiMocks.testToken.mockResolvedValueOnce({
      ok: false,
      status: "restricted",
      message: `Access denied for ${tokenValue}`,
      user: tokenValue,
      organizations: [tokenValue],
      checked_model: tokenValue,
      model_access_url: tokenValue
    });
    await act(async () => result.current.page.token.test());
    expect(result.current.page.token.result).toEqual({
      ok: false,
      status: "restricted",
      message: "Access denied for [redacted-token]"
    });
    expect(JSON.stringify(result.current.page.token.result)).not.toContain(tokenValue);

    act(() => { result.current.page.token.setInput("replacement-value"); });
    expect(result.current.page.token.result).toBeNull();
  });

  it("makes retained token actions inert after unmount", async () => {
    const { result, unmount } = await renderWorkspace();
    act(() => { result.current.page.token.setInput("synthetic-test-credential"); });
    const retainedTokenTest = result.current.page.token.test;
    const retainedPyannoteDownload = result.current.page.actions.downloadPyannote;
    unmount();

    await expect(retainedTokenTest()).resolves.toBe(false);
    await expect(retainedPyannoteDownload()).resolves.toBe(false);
    expect(apiMocks.testToken).not.toHaveBeenCalled();
    expect(apiMocks.downloadPyannote).not.toHaveBeenCalled();
  });

  it("uses an immutable trimmed token for Pyannote and clears it only after success", async () => {
    const { result } = await renderWorkspace();
    act(() => { result.current.page.token.setInput("  temporary-value  "); });
    apiMocks.downloadPyannote.mockResolvedValueOnce(readyPyannote);
    apiMocks.fetchStatus.mockResolvedValueOnce(readyCatalog);
    await act(async () => result.current.page.actions.downloadPyannote());
    expect(apiMocks.downloadPyannote).toHaveBeenCalledWith("temporary-value");
    expect(result.current.page.token.input).toBe("");

    const missingAgain = { ...readyCatalog, pyannote: missingCatalog.pyannote };
    apiMocks.fetchStatus.mockResolvedValueOnce(missingAgain);
    await act(async () => result.current.page.actions.refresh());
    act(() => { result.current.page.token.setInput("retry-value"); });
    apiMocks.downloadPyannote.mockRejectedValueOnce(new Error("failed"));
    await act(async () => result.current.page.actions.downloadPyannote());
    expect(result.current.page.token.input).toBe("retry-value");
  });

  it("binds deletion confirmation to one exact target and invokes deletion once", async () => {
    const { result } = await renderWorkspace(readyCatalog);
    act(() => {
      expect(result.current.page.actions.requestDeleteFasterWhisper("small")).toBe(true);
    });
    const requestKey = result.current.page.deletion.requestKey;
    const deletion = deferred<{ model: typeof missingCatalog.faster_whisper[0]; deleted_paths: string[] }>();
    apiMocks.deleteWhisper.mockReturnValueOnce(deletion.promise);

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = result.current.page.deletion.confirm(requestKey);
      duplicate = result.current.page.deletion.confirm(requestKey);
    });
    await expect(duplicate).resolves.toBe(false);
    expect(result.current.shell.activeJob).toBe(true);
    apiMocks.fetchStatus.mockResolvedValueOnce(missingCatalog);
    deletion.resolve({ model: missingCatalog.faster_whisper[0], deleted_paths: ["synthetic"] });
    await act(async () => first);

    expect(apiMocks.deleteWhisper).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteWhisper).toHaveBeenCalledWith("small");
    expect(result.current.shared.modelsStatus?.faster_whisper[0].availability).toBe("missing");
    expect(result.current.shell.activeJob).toBe(false);
  });

  it("keeps the catalog unchanged and unlocks deletion after a mismatched Whisper deletion response", async () => {
    const { result } = await renderWorkspace(readyCatalog);
    act(() => {
      expect(result.current.page.actions.requestDeleteFasterWhisper("small")).toBe(true);
    });
    const requestKey = result.current.page.deletion.requestKey;
    apiMocks.deleteWhisper.mockResolvedValueOnce({
      model: { ...missingCatalog.faster_whisper[1], installed: false, availability: "missing" as const },
      deleted_paths: []
    });

    await act(async () => {
      await expect(result.current.page.deletion.confirm(requestKey)).resolves.toBe(false);
    });

    expect(result.current.shared.modelsStatus).toEqual(readyCatalog);
    expect(result.current.page.operation.error).toBe("The local service returned an unexpected model response. Try again.");
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
    act(() => {
      expect(result.current.page.actions.requestDeleteFasterWhisper("small")).toBe(true);
    });
    const retryKey = result.current.page.deletion.requestKey;
    act(() => {
      expect(result.current.page.deletion.cancel(retryKey)).toBe(true);
    });
  });

  it("keeps the catalog unchanged and unlocks deletion after a mismatched Pyannote deletion response", async () => {
    const { result } = await renderWorkspace(readyCatalog);
    act(() => {
      expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
    });
    const requestKey = result.current.page.deletion.requestKey;
    apiMocks.deletePyannote.mockResolvedValueOnce({ ...missingCatalog.pyannote, model_id: "unexpected-model" });

    await act(async () => {
      await expect(result.current.page.deletion.confirm(requestKey)).resolves.toBe(false);
    });

    expect(result.current.shared.modelsStatus).toEqual(readyCatalog);
    expect(result.current.page.operation.error).toBe("The local service returned an unexpected model response. Try again.");
    expect(apiMocks.fetchStatus).toHaveBeenCalledTimes(1);
    act(() => {
      expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
    });
    const retryKey = result.current.page.deletion.requestKey;
    act(() => {
      expect(result.current.page.deletion.cancel(retryKey)).toBe(true);
    });
  });

  it("makes stale delete callbacks inert and keeps the catalog on deletion failure", async () => {
    const { result } = await renderWorkspace(readyCatalog);
    act(() => {
      expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
    });
    const staleKey = result.current.page.deletion.requestKey;
    act(() => {
      expect(result.current.page.deletion.cancel(staleKey)).toBe(true);
    });
    await expect(result.current.page.deletion.confirm(staleKey)).resolves.toBe(false);

    act(() => {
      expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
    });
    const currentKey = result.current.page.deletion.requestKey;
    apiMocks.deletePyannote.mockRejectedValueOnce(new Error("failed"));
    await act(async () => result.current.page.deletion.confirm(currentKey));
    expect(result.current.shared.modelsStatus?.pyannote.availability).toBe("ready");
    expect(result.current.page.operation.error).toContain("could not be deleted");
    expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
  });

  it("revalidates deletion readiness before calling the filesystem API", async () => {
    const catalog = structuredClone(readyCatalog);
    const { result } = await renderWorkspace(catalog);
    act(() => {
      expect(result.current.page.actions.requestDeleteFasterWhisper("small")).toBe(true);
    });
    const requestKey = result.current.page.deletion.requestKey;
    catalog.faster_whisper[0].installed = false;
    catalog.faster_whisper[0].availability = "missing";

    await act(async () => {
      await expect(result.current.page.deletion.confirm(requestKey)).resolves.toBe(false);
    });
    expect(apiMocks.deleteWhisper).not.toHaveBeenCalled();
    expect(result.current.page.operation.error).toContain("no longer available");
  });

  it("reconciles only pyannote after a successful pyannote deletion", async () => {
    const { result } = await renderWorkspace(readyCatalog);
    act(() => {
      expect(result.current.page.actions.requestDeletePyannote()).toBe(true);
    });
    const requestKey = result.current.page.deletion.requestKey;
    apiMocks.deletePyannote.mockResolvedValueOnce(missingCatalog.pyannote);
    const authoritative = { ...readyCatalog, pyannote: missingCatalog.pyannote };
    apiMocks.fetchStatus.mockResolvedValueOnce(authoritative);

    await act(async () => result.current.page.deletion.confirm(requestKey));
    expect(result.current.shared.modelsStatus?.pyannote.availability).toBe("missing");
    expect(result.current.shared.modelsStatus?.faster_whisper).toEqual(readyCatalog.faster_whisper);
    expect(apiMocks.deletePyannote).toHaveBeenCalledTimes(1);
  });

  it("opens only trusted catalog links and keeps a late failure from replacing a newer session", async () => {
    const { result, unmount } = await renderWorkspace();
    await act(async () => result.current.page.actions.openPyannoteModelPage());
    expect(apiMocks.openExternal).toHaveBeenCalledWith(missingCatalog.pyannote.model_url);

    const pending = deferred<void>();
    apiMocks.openExternal.mockReturnValueOnce(pending.promise);
    let action!: Promise<boolean>;
    act(() => { action = result.current.page.actions.openHuggingFaceTokenPage(); });
    unmount();
    pending.reject(new Error("failed"));
    await act(async () => action);
    expect(apiMocks.openExternal).toHaveBeenCalledTimes(2);
  });
});
