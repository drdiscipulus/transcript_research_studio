import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  API_TIMEOUTS,
  requestJson,
  resetBackendClientConfig
} from "./core";

export type HardwareSummary = {
  cpu_model: string;
  physical_cores: number;
  logical_cores: number;
  total_ram_gb: number;
  gpu_model: string;
  vram_gb: number | null;
  has_supported_nvidia_gpu: boolean;
  cuda_available: boolean;
  asr_cuda_available: boolean;
  pyannote_available: boolean;
  pyannote_cuda_available: boolean;
  runtime_variant: string;
  acceleration_path: string;
};

export type HardwareSystemSummary = {
  cpu_model: string;
  physical_cores: number;
  logical_cores: number;
  total_ram_gb: number;
  gpu_model: string;
  vram_gb: number | null;
  has_supported_nvidia_gpu: boolean;
  runtime_variant: string;
};

export type HardwareScanSnapshot = {
  generation: number;
  status: "checking" | "ready" | "failed";
  phase: "system" | "transcription_acceleration" | "speaker_acceleration" | "ready" | "failed";
  message: string;
  system: HardwareSystemSummary | null;
  hardware: HardwareSummary | null;
  retryable: boolean;
  retry_started?: boolean;
};

export async function fetchHardwareStatus(): Promise<HardwareScanSnapshot> {
  return await requestJson<HardwareScanSnapshot>("/api/v1/system/hardware", {
    timeoutMs: API_TIMEOUTS.health,
    operation: "Hardware detection"
  });
}

export async function retryHardwareScan(): Promise<HardwareScanSnapshot> {
  return await requestJson<HardwareScanSnapshot>("/api/v1/system/hardware/retry", {
    method: "POST",
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Hardware detection retry"
  });
}

export type PickFolderResult = {
  selected_path: string | null;
};

export type OpenPathResult = {
  opened_path: string;
};

export async function pickFolder(initialDirectory?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_folder_native", {
      initialDirectory: initialDirectory ?? null
    });
  }

  const payload = await requestJson<PickFolderResult>("/api/v1/system/pick-folder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(initialDirectory ? { initial_directory: initialDirectory } : {}),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Folder picker"
  });
  return payload.selected_path;
}

export async function pickTranscriptFile(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_transcript_file_native", {
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Transcript file picking is only available in the desktop app.");
}

export async function pickEvidenceProjectFile(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_evidence_project_file_native", {
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Coding project file picking is only available in the desktop app.");
}

export async function pickMediaFile(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_media_file_native", {
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Media file picking is only available in the desktop app.");
}

export async function pickSaveFile(defaultFileName?: string, initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_save_file_native", {
      defaultFileName: defaultFileName ?? null,
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Save file picking is only available in the desktop app.");
}

export async function pickEditorExportFile(
  defaultFileName?: string,
  initialPath?: string,
  exportFormats: string[] = []
): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_editor_export_file_native", {
      defaultFileName: defaultFileName ?? null,
      initialPath: initialPath ?? null,
      exportFormats
    });
  }

  throw new Error("Transcript export file picking is only available in the desktop app.");
}

export async function pickCodesExportBundleFile(
  defaultFileName?: string,
  initialPath?: string
): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_codes_export_bundle_file_native", {
      defaultFileName: defaultFileName ?? null,
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Coding project export bundle picking is only available in the desktop app.");
}

export async function pickEvidenceProjectSaveFile(defaultFileName?: string, initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_evidence_project_save_file_native", {
      defaultFileName: defaultFileName ?? null,
      initialPath: initialPath ?? null
    });
  }

  throw new Error("Coding project save file picking is only available in the desktop app.");
}

export function localMediaUrl(path: string): string {
  if (!path.trim()) {
    return "";
  }
  return isTauri() ? convertFileSrc(path) : path;
}

export async function openPath(payload: {
  path: string;
  expect_directory?: boolean;
  create_if_missing?: boolean;
}): Promise<OpenPathResult> {
  if (isTauri()) {
    const openedPath = await invoke<string>("open_path_native", {
      path: payload.path,
      expectDirectory: payload.expect_directory ?? null,
      createIfMissing: payload.create_if_missing ?? null
    });
    return { opened_path: openedPath };
  }

  return await requestJson<OpenPathResult>("/api/v1/system/open-path", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Open path"
  });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_external_url_native", { url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function restartSidecar(): Promise<void> {
  if (!isTauri()) {
    throw new Error("Service restart is only available in the desktop app.");
  }
  await invoke("restart_sidecar");
  resetBackendClientConfig();
}

export async function openStartupLog(): Promise<void> {
  if (!isTauri()) {
    throw new Error("The startup log is only available in the desktop app.");
  }
  await invoke("open_startup_log");
}
