import {
  API_TIMEOUTS,
  requestJson,
  type PreparedExport
} from "./core";

export type SuggestedFolders = {
  input_folder: string;
  transcript_output_folder: string;
  prompt_output_folder: string;
};

export type SimpleOptions = {
  language: string;
  language_options: TranscriptionLanguageOption[];
  output_mode: string;
  export_formats: string[];
  transcript_layout: string;
  paragraph_options?: ParagraphOptions;
  model_name: string;
  acceleration: string;
  model_options: TranscriptionModelOption[];
};

export type TranscriptionLanguageOption = {
  value: string;
  label: string;
  supported_models?: string[];
  description?: string;
};

export type ParagraphOptions = {
  paragraph_pause_enabled: boolean;
  max_pause_seconds: number;
};

export type TranscriptionModelOption = {
  value: string;
  label: string;
  installed: boolean;
  bundled: boolean;
};

export type AccelerationOption = {
  value: string;
  label: string;
};

export type ScanItem = {
  file_name: string;
  source_path?: string;
  extension: string;
  size_bytes: number;
  modified_at: string;
  duration_seconds: number | null;
  duration_label: string;
  file_info: string;
};

export type ScanExclusion = {
  file_name: string;
  source_path?: string;
  extension: string;
  size_bytes: number;
  code: string;
  message: string;
};

export type ScanPreview = {
  input_folder: string;
  input_source_type?: string;
  input_path?: string;
  file_count: number;
  total_duration_seconds: number | null;
  total_duration_label: string;
  duration_status: string;
  is_empty: boolean;
  message: string;
  files: ScanItem[];
  excluded_count?: number;
  excluded_files?: ScanExclusion[];
};

export type RunScreenPayload = {
  suggested_folders: SuggestedFolders;
  browse_home_folder: string;
  simple_options: SimpleOptions;
  batch_name: string;
};

export type BatchFileStatus = {
  file_name: string;
  duration_label: string;
  file_info: string;
  status: string;
  transcript_preview: string;
  error: string | null;
  error_code?: string | null;
  engine: string | null;
  warnings: string[];
  device?: string | null;
  used_fallback?: boolean;
};

export type BatchRunSnapshot = {
  batch_id: string | null;
  batch_name: string | null;
  status: string;
  message: string;
  progress_percent: number;
  files_completed: number;
  total_files: number;
  current_file_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  output_files: PreparedExport[];
  files: BatchFileStatus[];
  counts: Record<string, number>;
  log_file: string | null;
  warnings: string[];
  exclusions?: ScanExclusion[];
  excluded_count?: number;
  error_code?: string | null;
};

export async function fetchRunScreenPayload(): Promise<RunScreenPayload> {
  return await requestJson<RunScreenPayload>("/api/v1/transcription/run-screen", {
    timeoutMs: API_TIMEOUTS.read,
    operation: "Transcription setup"
  });
}

export async function scanInputSource(inputSourceType: string, inputPath: string): Promise<ScanPreview> {
  return await requestJson<ScanPreview>("/api/v1/transcription/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_source_type: inputSourceType,
      input_path: inputPath
    }),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Input scan"
  });
}

export async function startBatch(payload: {
  input_source_type: string;
  input_path: string;
  transcript_output_folder: string;
  output_organization: "separate_files" | "combined_file";
  output_naming_mode: string;
  output_basename: string;
  language: string;
  output_mode: string;
  export_formats: string[];
  transcript_layout: string;
  paragraph_options: ParagraphOptions;
  model_name: string;
  acceleration: string;
}): Promise<BatchRunSnapshot> {
  return await requestJson<BatchRunSnapshot>("/api/v1/transcription/start-batch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Start transcription"
  });
}

export async function fetchCurrentBatch(): Promise<BatchRunSnapshot> {
  return await requestJson<BatchRunSnapshot>("/api/v1/transcription/current-batch", {
    timeoutMs: API_TIMEOUTS.health,
    operation: "Transcription status"
  });
}

export async function cancelBatch(): Promise<BatchRunSnapshot> {
  return await requestJson<BatchRunSnapshot>("/api/v1/transcription/cancel-batch", {
    method: "POST",
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Stop transcription"
  });
}
