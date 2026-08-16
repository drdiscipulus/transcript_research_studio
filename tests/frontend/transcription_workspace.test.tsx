import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTranscriptionWorkspace } from "../../src/hooks/useTranscriptionWorkspace";
import type {
  AppSettings,
  BatchRunSnapshot,
  HardwareScanSnapshot,
  ModelsStatus,
  RunScreenPayload,
  ScanPreview
} from "../../src/lib/api";
import type { UseTranscriptionWorkspaceOptions } from "../../src/lib/transcriptionWorkspaceContracts";

const apiMocks = vi.hoisted(() => ({
  cancelBatch: vi.fn(),
  fetchBackendHealth: vi.fn(),
  fetchCurrentBatch: vi.fn(),
  fetchRunScreenPayload: vi.fn(),
  openPath: vi.fn(),
  pickFolder: vi.fn(),
  pickMediaFile: vi.fn(),
  saveAppSettings: vi.fn(),
  scanInputSource: vi.fn(),
  startBatch: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, ...apiMocks };
});

const settings: AppSettings = {
  theme_override: "light",
  advanced_transcription: {
    diarization_enabled: false,
    include_timestamps: true,
    beam_size: 5,
    vad_filter: true,
    temperature: 0,
    compute_type: "int8",
    speaker_mode: "auto",
    exact_speakers: null,
    min_speakers: null,
    max_speakers: null
  }
};

function settingsWithTimestamps(includeTimestamps: boolean): AppSettings {
  return {
    ...settings,
    advanced_transcription: {
      ...settings.advanced_transcription,
      include_timestamps: includeTimestamps
    }
  };
}

const hardware = {
  cpu_model: "Test CPU",
  physical_cores: 8,
  logical_cores: 16,
  total_ram_gb: 32,
  gpu_model: "None",
  vram_gb: null,
  has_supported_nvidia_gpu: false,
  cuda_available: false,
  asr_cuda_available: false,
  pyannote_available: true,
  pyannote_cuda_available: false,
  runtime_variant: "cpu",
  acceleration_path: "CPU"
};

const readyHardwareSnapshot: HardwareScanSnapshot = {
  generation: 1,
  status: "ready",
  phase: "ready",
  message: "Hardware detection complete.",
  system: {
    cpu_model: hardware.cpu_model,
    physical_cores: hardware.physical_cores,
    logical_cores: hardware.logical_cores,
    total_ram_gb: hardware.total_ram_gb,
    gpu_model: hardware.gpu_model,
    vram_gb: hardware.vram_gb,
    has_supported_nvidia_gpu: hardware.has_supported_nvidia_gpu,
    runtime_variant: hardware.runtime_variant
  },
  hardware,
  retryable: false
};

const checkingHardwareSnapshot: HardwareScanSnapshot = {
  generation: 1,
  status: "checking",
  phase: "transcription_acceleration",
  message: "Checking CUDA runtime...",
  system: {
    cpu_model: "Test CPU",
    physical_cores: 8,
    logical_cores: 16,
    total_ram_gb: 32,
    gpu_model: "NVIDIA GeForce RTX 5090",
    vram_gb: 31.8,
    has_supported_nvidia_gpu: true,
    runtime_variant: "windows-gpu"
  },
  hardware: null,
  retryable: false
};

const cudaHardwareSnapshot: HardwareScanSnapshot = {
  ...checkingHardwareSnapshot,
  status: "ready",
  phase: "ready",
  message: "Hardware detection complete.",
  hardware: {
    ...hardware,
    gpu_model: "NVIDIA GeForce RTX 5090",
    vram_gb: 31.8,
    has_supported_nvidia_gpu: true,
    cuda_available: true,
    asr_cuda_available: true,
    pyannote_cuda_available: true,
    runtime_variant: "windows-gpu",
    acceleration_path: "NVIDIA / CUDA"
  }
};

const bootstrap: RunScreenPayload = {
  suggested_folders: {
    input_folder: "C:\\suggested\\input",
    transcript_output_folder: "C:\\suggested\\output",
    prompt_output_folder: "C:\\suggested\\analysis"
  },
  browse_home_folder: "C:\\research",
  simple_options: {
    language: "auto",
    output_mode: "transcribe",
    export_formats: ["xlsx"],
    transcript_layout: "file",
    paragraph_options: { paragraph_pause_enabled: true, max_pause_seconds: 3 },
    model_name: "small",
    acceleration: "cpu",
    model_options: [
      { value: "small", label: "Small", installed: true, bundled: false }
    ]
  },
  batch_name: "transcripts"
};

const modelsStatus: ModelsStatus = {
  faster_whisper: [
    {
      value: "small",
      label: "Small",
      repo_id: "small",
      installed: false,
      availability: "incomplete",
      missing_files: ["model.bin"]
    },
    {
      value: "medium",
      label: "Medium",
      repo_id: "medium",
      installed: true,
      availability: "ready",
      missing_files: []
    }
  ],
  pyannote: {
    model_id: "pyannote",
    model_url: "https://example.invalid/model",
    token_url: "https://example.invalid/token",
    model_dir: "models/pyannote",
    installed: true,
    availability: "ready",
    missing_files: []
  }
};

function batch(status: string, batchId: string | null = null): BatchRunSnapshot {
  return {
    batch_id: batchId,
    batch_name: batchId,
    status,
    message: status,
    progress_percent: 0,
    files_completed: 0,
    total_files: batchId ? 1 : 0,
    current_file_name: null,
    started_at: null,
    finished_at: null,
    output_files: [],
    files: [],
    counts: {},
    log_file: null,
    warnings: []
  };
}

function scan(path: string): ScanPreview {
  return {
    input_folder: path,
    input_source_type: "folder",
    input_path: path,
    file_count: 1,
    total_duration_seconds: 30,
    total_duration_label: "0:30",
    duration_status: "available",
    is_empty: false,
    message: `Ready: ${path}`,
    files: [{
      file_name: "interview.wav",
      source_path: `${path}\\interview.wav`,
      extension: ".wav",
      size_bytes: 10_000,
      modified_at: "2026-08-06T10:00:00Z",
      duration_seconds: 30,
      duration_label: "0:30",
      file_info: "WAV"
    }],
    excluded_count: 0,
    excluded_files: []
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

function workspaceOptions(overrides: Partial<UseTranscriptionWorkspaceOptions> = {}): UseTranscriptionWorkspaceOptions {
  return {
    appSettings: settings,
    settingsLoading: false,
    settingsError: null,
    modelsStatus,
    modelsStatusLoading: false,
    modelsStatusError: null,
    hardwareSnapshot: readyHardwareSnapshot,
    hardwareRequestError: null,
    onRetryHardwareScan: vi.fn(async () => true),
    onSettingsChanged: vi.fn(),
    onSettingsError: vi.fn(),
    ...overrides
  };
}

describe("useTranscriptionWorkspace", () => {
  beforeEach(() => {
    apiMocks.cancelBatch.mockReset();
    apiMocks.fetchBackendHealth.mockReset().mockResolvedValue({
      bind: "127.0.0.1",
      environment: "test",
      status: "ready",
      instance_id: "sidecar-a",
      started_at: "2026-08-06T10:00:00Z"
    });
    apiMocks.fetchCurrentBatch.mockReset().mockResolvedValue(batch("idle"));
    apiMocks.fetchRunScreenPayload.mockReset().mockResolvedValue(bootstrap);
    apiMocks.openPath.mockReset().mockResolvedValue(undefined);
    apiMocks.pickFolder.mockReset();
    apiMocks.pickMediaFile.mockReset();
    apiMocks.saveAppSettings.mockReset().mockResolvedValue(settings);
    apiMocks.scanInputSource.mockReset();
    apiMocks.startBatch.mockReset();
  });

  it("re-arms bootstrap in Strict Mode and respects authoritative ready model status", async () => {
    const { result } = renderHook(
      () => useTranscriptionWorkspace(workspaceOptions()),
      { reactStrictMode: true }
    );

    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    expect(apiMocks.fetchRunScreenPayload.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.page.setup.state.modelName).toBe("medium");
    expect(result.current.page.setup.state.modelOptions.map((option) => [option.value, option.installed])).toEqual([
      ["small", false],
      ["medium", true]
    ]);
    expect(result.current.shell.browseHomeFolder).toBe("C:\\research");
  });

  it("loads immediately with CPU while hardware is checking and adds CUDA without replacing a manual choice", async () => {
    const rendered = renderHook(
      ({ snapshot }: { snapshot: HardwareScanSnapshot }) => useTranscriptionWorkspace(workspaceOptions({
        hardwareSnapshot: snapshot
      })),
      { initialProps: { snapshot: checkingHardwareSnapshot } }
    );

    await waitFor(() => expect(rendered.result.current.page.setup.state.loading).toBe(false));
    expect(rendered.result.current.page.setup.state.accelerationOptions).toEqual([
      { value: "cpu", label: "CPU" }
    ]);
    expect(rendered.result.current.page.setup.state.acceleration).toBe("cpu");
    expect(rendered.result.current.page.setup.state.hardwareStatus).toBe("checking");

    act(() => rendered.result.current.page.setup.actions.setAcceleration("cpu"));
    rendered.rerender({ snapshot: cudaHardwareSnapshot });

    await waitFor(() => expect(rendered.result.current.page.setup.state.accelerationOptions).toEqual([
      { value: "cpu", label: "CPU" },
      { value: "cuda", label: "NVIDIA / CUDA" }
    ]));
    expect(rendered.result.current.page.setup.state.acceleration).toBe("cpu");
  });

  it("automatically selects newly verified CUDA only when acceleration is untouched", async () => {
    const rendered = renderHook(
      ({ snapshot }: { snapshot: HardwareScanSnapshot }) => useTranscriptionWorkspace(workspaceOptions({
        hardwareSnapshot: snapshot
      })),
      { initialProps: { snapshot: checkingHardwareSnapshot } }
    );

    await waitFor(() => expect(rendered.result.current.page.setup.state.loading).toBe(false));
    expect(rendered.result.current.page.setup.state.acceleration).toBe("cpu");
    rendered.rerender({ snapshot: cudaHardwareSnapshot });
    await waitFor(() => expect(rendered.result.current.page.setup.state.acceleration).toBe("cuda"));
  });

  it("keeps CPU transcription eligible while hardware detection is still checking", async () => {
    apiMocks.scanInputSource.mockResolvedValue(scan("C:\\research\\input"));
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\input")
      .mockResolvedValueOnce("C:\\research\\output");
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-a"));
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      hardwareSnapshot: checkingHardwareSnapshot
    })));

    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(result.current.page.scan.preview?.file_count).toBe(1), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });

    expect(result.current.page.setup.state.acceleration).toBe("cpu");
    expect(result.current.page.run.state.canStart).toBe(true);
    await act(async () => expect(await result.current.page.run.actions.start()).toBe(true));
    expect(apiMocks.startBatch).toHaveBeenCalledWith(expect.objectContaining({ acceleration: "cpu" }));
  });

  it("does not let a late bootstrap overwrite a researcher-selected output folder", async () => {
    const pendingBootstrap = deferred<RunScreenPayload>();
    apiMocks.fetchRunScreenPayload.mockReturnValue(pendingBootstrap.promise);
    apiMocks.pickFolder.mockResolvedValue("C:\\chosen\\output");
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions()));

    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });
    expect(result.current.page.setup.state.transcriptOutputFolder).toBe("C:\\chosen\\output");
    pendingBootstrap.resolve(bootstrap);
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    expect(result.current.page.setup.state.transcriptOutputFolder).toBe("C:\\chosen\\output");
  });

  it("binds previews to the latest exact input and keeps picker cancellation silent", async () => {
    const firstScan = deferred<ScanPreview>();
    const secondScan = deferred<ScanPreview>();
    apiMocks.scanInputSource
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise);
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\first")
      .mockResolvedValueOnce("C:\\research\\second");
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions()));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(apiMocks.scanInputSource).toHaveBeenCalledWith("folder", "C:\\research\\first"), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    expect(result.current.page.scan.preview).toBeNull();
    await waitFor(() => expect(apiMocks.scanInputSource).toHaveBeenCalledWith("folder", "C:\\research\\second"), { timeout: 2_000 });

    secondScan.resolve(scan("C:\\research\\second"));
    await waitFor(() => expect(result.current.page.scan.preview?.input_path).toBe("C:\\research\\second"));
    firstScan.resolve(scan("C:\\research\\first"));
    await act(async () => { await firstScan.promise; });
    expect(result.current.page.scan.preview?.input_path).toBe("C:\\research\\second");

    apiMocks.pickFolder.mockRejectedValueOnce(new Error("Picker unavailable."));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    expect(result.current.page.setup.state.pathActionError).toBe("Picker unavailable.");
    expect(result.current.page.scan.preview?.input_path).toBe("C:\\research\\second");
    apiMocks.pickFolder.mockResolvedValueOnce(null);
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    expect(result.current.page.setup.state.pathActionError).toBe("Picker unavailable.");
    expect(result.current.page.scan.preview?.input_path).toBe("C:\\research\\second");
  });

  it("invalidates a pending scan immediately when input is cleared", async () => {
    const pendingScan = deferred<ScanPreview>();
    apiMocks.scanInputSource.mockReturnValue(pendingScan.promise);
    apiMocks.pickFolder.mockResolvedValue("C:\\research\\pending");
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions()));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(apiMocks.scanInputSource).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    act(() => result.current.page.setup.actions.clearInput());
    expect(result.current.page.setup.state.inputPath).toBe("");
    expect(result.current.page.scan.preview).toBeNull();

    pendingScan.resolve(scan("C:\\research\\pending"));
    await act(async () => { await pendingScan.promise; });
    expect(result.current.page.scan.preview).toBeNull();
    expect(result.current.page.run.state.canStart).toBe(false);
  });

  it("lets New Run invalidate an obsolete pending picker result", async () => {
    const pendingPicker = deferred<string | null>();
    apiMocks.pickFolder.mockReturnValue(pendingPicker.promise);
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions()));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    let pickerResult!: Promise<void>;
    act(() => { pickerResult = result.current.page.setup.actions.pickInputSource("folder"); });
    expect(result.current.page.run.actions.newRun()).toBe(true);
    pendingPicker.resolve("C:\\research\\obsolete");
    await act(async () => { await pickerResult; });

    expect(result.current.page.setup.state.inputPath).toBe("");
    expect(result.current.page.scan.preview).toBeNull();
    expect(apiMocks.scanInputSource).not.toHaveBeenCalled();
  });

  it("captures an immutable start payload and locks setup synchronously", async () => {
    const pendingStart = deferred<BatchRunSnapshot>();
    apiMocks.startBatch.mockReturnValue(pendingStart.promise);
    apiMocks.scanInputSource.mockResolvedValue(scan("C:\\research\\input"));
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\input")
      .mockResolvedValueOnce("C:\\research\\output");
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions()));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(result.current.page.scan.preview?.file_count).toBe(1), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });
    await waitFor(() => expect(result.current.page.run.state.canStart).toBe(true));

    let startResult!: Promise<boolean>;
    act(() => {
      startResult = result.current.page.run.actions.start();
      result.current.page.setup.actions.clearInput();
      result.current.page.setup.actions.toggleExportFormat("csv", true);
    });

    expect(apiMocks.startBatch).toHaveBeenCalledTimes(1);
    expect(result.current.page.setup.state.inputPath).toBe("C:\\research\\input");
    expect(result.current.page.setup.state.exportFormats).toEqual(["xlsx"]);
    expect(apiMocks.startBatch.mock.calls[0][0]).toMatchObject({
      input_path: "C:\\research\\input",
      transcript_output_folder: "C:\\research\\output",
      export_formats: ["xlsx"],
      model_name: "medium"
    });

    pendingStart.resolve(batch("running", "batch-a"));
    await act(async () => expect(await startResult).toBe(true));
    expect(result.current.page.setup.state.configurationLocked).toBe(true);
  });

  it("blocks Start synchronously while DOCX timestamp preference is being saved", async () => {
    const pendingSave = deferred<AppSettings>();
    const currentSettings = settingsWithTimestamps(false);
    apiMocks.saveAppSettings.mockReturnValue(pendingSave.promise);
    apiMocks.scanInputSource.mockResolvedValue(scan("C:\\research\\input"));
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\input")
      .mockResolvedValueOnce("C:\\research\\output");
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-a"));
    const onSettingsChanged = vi.fn();
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      onSettingsChanged
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(result.current.page.scan.preview?.file_count).toBe(1), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });

    let blockedStart!: Promise<boolean>;
    act(() => {
      result.current.page.setup.actions.toggleExportFormat("docx", true);
      blockedStart = result.current.page.run.actions.start();
    });
    await expect(blockedStart).resolves.toBe(false);
    expect(result.current.page.setup.state.settingsSavePending).toBe(true);
    expect(apiMocks.startBatch).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledWith({
      advanced_transcription: expect.objectContaining({ include_timestamps: true })
    }));

    pendingSave.resolve(settingsWithTimestamps(true));
    await waitFor(() => expect(result.current.page.setup.state.settingsSavePending).toBe(false));
    expect(onSettingsChanged).toHaveBeenCalledWith(settingsWithTimestamps(true));
    await act(async () => expect(await result.current.page.run.actions.start()).toBe(true));
    expect(apiMocks.startBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the immediate Start path eligible when accepted settings do not require Pyannote", async () => {
    const currentSettings = settingsWithTimestamps(false);
    const pyannoteUnavailable = {
      ...modelsStatus,
      pyannote: {
        ...modelsStatus.pyannote,
        installed: false,
        availability: "incomplete" as const,
        missing_files: ["config.yaml"]
      }
    };
    apiMocks.saveAppSettings
      .mockResolvedValueOnce({
        ...currentSettings,
        advanced_transcription: {
          ...currentSettings.advanced_transcription,
          include_timestamps: true
        }
      });
    apiMocks.scanInputSource.mockResolvedValue(scan("C:\\research\\input"));
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\input")
      .mockResolvedValueOnce("C:\\research\\output");
    apiMocks.startBatch.mockResolvedValue(batch("running", "batch-a"));
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      modelsStatus: pyannoteUnavailable
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(result.current.page.scan.preview?.file_count).toBe(1), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });
    expect(result.current.page.run.state.canStart).toBe(true);

    await act(async () => {
      await result.current.page.setup.actions.updateAdvancedToggle("include_timestamps", true);
    });
    await expect(result.current.page.run.actions.start()).resolves.toBe(true);
    expect(apiMocks.startBatch).toHaveBeenCalledTimes(1);
  });

  it("uses accepted diarization settings immediately when evaluating Start eligibility", async () => {
    const currentSettings = settingsWithTimestamps(false);
    const pyannoteUnavailable = {
      ...modelsStatus,
      pyannote: {
        ...modelsStatus.pyannote,
        installed: false,
        availability: "incomplete" as const,
        missing_files: ["config.yaml"]
      }
    };
    const savedSettings = {
      ...currentSettings,
      advanced_transcription: {
        ...currentSettings.advanced_transcription,
        diarization_enabled: true
      }
    };
    apiMocks.saveAppSettings.mockResolvedValue(savedSettings);
    apiMocks.scanInputSource.mockResolvedValue(scan("C:\\research\\input"));
    apiMocks.pickFolder
      .mockResolvedValueOnce("C:\\research\\input")
      .mockResolvedValueOnce("C:\\research\\output");
    const { result, rerender } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      modelsStatus: pyannoteUnavailable
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));
    await act(async () => { await result.current.page.setup.actions.pickInputSource("folder"); });
    await waitFor(() => expect(result.current.page.scan.preview?.file_count).toBe(1), { timeout: 2_000 });
    await act(async () => { await result.current.page.setup.actions.pickOutputFolder(); });
    expect(result.current.page.run.state.canStart).toBe(true);

    await act(async () => {
      await result.current.page.setup.actions.updateAdvancedToggle("diarization_enabled", true);
    });
    expect(apiMocks.saveAppSettings).toHaveBeenCalledWith({
      advanced_transcription: expect.objectContaining({ diarization_enabled: true })
    });
    rerender();
    expect(result.current.page.run.state.canStart).toBe(false);
    await expect(result.current.page.run.actions.start()).resolves.toBe(false);
    expect(apiMocks.startBatch).not.toHaveBeenCalled();
  });

  it("reports a DOCX preference failure without publishing false success", async () => {
    const currentSettings = settingsWithTimestamps(false);
    apiMocks.saveAppSettings.mockRejectedValue(new Error("Timestamp preference could not be saved."));
    const onSettingsChanged = vi.fn();
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      onSettingsChanged
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    act(() => result.current.page.setup.actions.toggleExportFormat("docx", true));
    expect(result.current.page.setup.state.settingsSavePending).toBe(true);
    await waitFor(() => expect(result.current.page.setup.state.settingsSavePending).toBe(false));
    expect(result.current.page.setup.state.settingsPersistenceError).toBe(
      "Timestamp preference could not be saved."
    );
    expect(onSettingsChanged).not.toHaveBeenCalled();
    expect(result.current.page.setup.state.exportFormats).toContain("docx");
  });

  it("serializes rapid settings mutations and publishes only the newest intent", async () => {
    const firstSave = deferred<AppSettings>();
    const secondSave = deferred<AppSettings>();
    const currentSettings = settingsWithTimestamps(false);
    apiMocks.saveAppSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const onSettingsChanged = vi.fn();
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      onSettingsChanged
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    let firstResult!: Promise<void>;
    let secondResult!: Promise<void>;
    act(() => {
      firstResult = result.current.page.setup.actions.updateAdvancedToggle("diarization_enabled", true);
      secondResult = result.current.page.setup.actions.updateAdvancedToggle("include_timestamps", true);
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveAppSettings.mock.calls[0][0].advanced_transcription).toMatchObject({
      diarization_enabled: true,
      include_timestamps: false
    });
    expect(result.current.page.setup.state.settingsSavePending).toBe(true);

    firstSave.resolve({
      ...currentSettings,
      advanced_transcription: {
        ...currentSettings.advanced_transcription,
        diarization_enabled: true
      }
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(2));
    expect(apiMocks.saveAppSettings.mock.calls[1][0].advanced_transcription).toMatchObject({
      diarization_enabled: true,
      include_timestamps: true
    });
    expect(result.current.page.setup.state.settingsSavePending).toBe(true);
    expect(onSettingsChanged).not.toHaveBeenCalled();

    const newestSettings = {
      ...currentSettings,
      advanced_transcription: {
        ...currentSettings.advanced_transcription,
        diarization_enabled: true,
        include_timestamps: true
      }
    };
    secondSave.resolve(newestSettings);
    await act(async () => { await Promise.all([firstResult, secondResult]); });
    expect(result.current.page.setup.state.settingsSavePending).toBe(false);
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith(newestSettings);
  });

  it("composes an Advanced Settings draft with a newer top-level toggle intent", async () => {
    const firstSave = deferred<AppSettings>();
    const secondSave = deferred<AppSettings>();
    const currentSettings = settingsWithTimestamps(false);
    apiMocks.saveAppSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const onSettingsChanged = vi.fn();
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: currentSettings,
      onSettingsChanged
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    let toggleResult!: Promise<void>;
    let draftResult!: Promise<AppSettings | null>;
    act(() => {
      toggleResult = result.current.page.setup.actions.updateAdvancedToggle("include_timestamps", true);
      draftResult = result.current.page.setup.actions.saveAdvancedSettings({
        ...currentSettings.advanced_transcription,
        beam_size: 7
      });
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveAppSettings.mock.calls[0][0].advanced_transcription).toMatchObject({
      beam_size: 5,
      include_timestamps: true
    });

    firstSave.resolve({
      ...currentSettings,
      advanced_transcription: {
        ...currentSettings.advanced_transcription,
        include_timestamps: true
      }
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(2));
    expect(apiMocks.saveAppSettings.mock.calls[1][0].advanced_transcription).toMatchObject({
      beam_size: 7,
      include_timestamps: true
    });

    const newestSettings = {
      ...currentSettings,
      advanced_transcription: {
        ...currentSettings.advanced_transcription,
        beam_size: 7,
        include_timestamps: true
      }
    };
    secondSave.resolve(newestSettings);
    await act(async () => { await Promise.all([toggleResult, draftResult]); });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith(newestSettings);
  });

  it("does not let an older completion clear a newer settings error", async () => {
    const firstSave = deferred<AppSettings>();
    const secondSave = deferred<AppSettings>();
    apiMocks.saveAppSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { result } = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: settingsWithTimestamps(false)
    })));
    await waitFor(() => expect(result.current.page.setup.state.loading).toBe(false));

    act(() => {
      void result.current.page.setup.actions.updateAdvancedToggle("diarization_enabled", true);
      void result.current.page.setup.actions.updateAdvancedToggle("include_timestamps", true);
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(1));
    firstSave.resolve(settings);
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(2));
    secondSave.reject(new Error("Newest settings failed."));

    await waitFor(() => expect(result.current.page.setup.state.settingsSavePending).toBe(false));
    expect(result.current.page.setup.state.settingsPersistenceError).toBe("Newest settings failed.");
  });

  it("keeps picker and settings completions silent after unmount", async () => {
    const pendingPicker = deferred<string | null>();
    const pendingSave = deferred<AppSettings>();
    apiMocks.pickFolder.mockReturnValue(pendingPicker.promise);
    apiMocks.saveAppSettings.mockReturnValue(pendingSave.promise);
    const onSettingsChanged = vi.fn();
    const rendered = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: settingsWithTimestamps(false),
      onSettingsChanged
    })));
    await waitFor(() => expect(rendered.result.current.page.setup.state.loading).toBe(false));

    let pickerResult!: Promise<void>;
    let saveResult!: Promise<AppSettings | null>;
    act(() => {
      pickerResult = rendered.result.current.page.setup.actions.pickInputSource("folder");
    });
    const retainedPick = rendered.result.current.page.setup.actions.pickInputSource;
    const retainedOpenPath = rendered.result.current.page.setup.actions.openPath;
    rendered.unmount();
    pendingPicker.resolve("C:\\research\\late");
    await pickerResult;
    await retainedPick("folder");
    await retainedOpenPath("C:\\research\\late");
    expect(apiMocks.pickFolder).toHaveBeenCalledTimes(1);
    expect(apiMocks.scanInputSource).not.toHaveBeenCalled();
    expect(apiMocks.openPath).not.toHaveBeenCalled();

    const second = renderHook(() => useTranscriptionWorkspace(workspaceOptions({
      appSettings: settingsWithTimestamps(false),
      onSettingsChanged
    })));
    await waitFor(() => expect(second.result.current.page.setup.state.loading).toBe(false));
    act(() => {
      saveResult = second.result.current.page.setup.actions.saveAdvancedSettings({
        ...settings.advanced_transcription,
        beam_size: 7
      });
    });
    await waitFor(() => expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(1));
    const lateSave = second.result.current.page.setup.actions.saveAdvancedSettings;
    second.unmount();
    pendingSave.resolve(settings);
    await expect(saveResult).resolves.toBeNull();
    await expect(lateSave(settings.advanced_transcription)).resolves.toBeNull();
    expect(apiMocks.saveAppSettings).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });
});
