import { API_TIMEOUTS, requestJson } from "./core";

export type HfTokenTestResult = {
  ok: boolean;
  status: string;
  message: string;
  user: string | null;
  organizations: string[];
  checked_model?: string | null;
  model_access_url?: string | null;
};

export type PyannoteModelStatus = {
  model_id: string;
  model_url: string;
  token_url: string;
  model_dir: string;
  installed: boolean;
  availability?: "missing" | "incomplete" | "ready";
  missing_files?: string[];
};

export type FasterWhisperModelStatus = {
  value: string;
  label: string;
  repo_id: string;
  installed: boolean;
  availability?: "missing" | "incomplete" | "ready";
  missing_files?: string[];
};

export type ModelsStatus = {
  faster_whisper: FasterWhisperModelStatus[];
  pyannote: PyannoteModelStatus;
};

export type ModelDownloadProgress = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  percent: number;
  downloaded_bytes: number;
  total_bytes: number;
  message: string;
  updated_at: string;
};

export type ModelDownloadProgressPayload = {
  downloads: Record<string, ModelDownloadProgress>;
};

export async function testHfToken(token?: string): Promise<HfTokenTestResult> {
  return await requestJson<HfTokenTestResult>("/api/v1/advanced/hf-token/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(token ? { token } : {}),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Hugging Face token test"
  });
}

export async function fetchModelsStatus(): Promise<ModelsStatus> {
  return await requestJson<ModelsStatus>("/api/v1/models/status", {
    timeoutMs: API_TIMEOUTS.read,
    operation: "Model status"
  });
}

export async function fetchModelDownloadProgress(): Promise<ModelDownloadProgressPayload> {
  return await requestJson<ModelDownloadProgressPayload>("/api/v1/models/download-progress", {
    timeoutMs: API_TIMEOUTS.health,
    operation: "Model download progress"
  });
}

export async function downloadPyannoteModel(token: string): Promise<PyannoteModelStatus> {
  return await requestJson<PyannoteModelStatus>("/api/v1/advanced/pyannote-model/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token }),
    timeoutMs: API_TIMEOUTS.longMutation,
    operation: "Pyannote model download"
  });
}

export async function deletePyannoteModel(): Promise<PyannoteModelStatus> {
  return await requestJson<PyannoteModelStatus>("/api/v1/advanced/pyannote-model/delete", {
    method: "POST",
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Delete pyannote model"
  });
}

export async function downloadFasterWhisperModel(modelName: string): Promise<{
  model: FasterWhisperModelStatus;
}> {
  return await requestJson<{ model: FasterWhisperModelStatus }>("/api/v1/models/faster-whisper/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model_name: modelName }),
    timeoutMs: API_TIMEOUTS.longMutation,
    operation: "Whisper model download"
  });
}

export async function deleteFasterWhisperModel(modelName: string): Promise<{
  model: FasterWhisperModelStatus;
  deleted_paths: string[];
}> {
  return await requestJson<{ model: FasterWhisperModelStatus; deleted_paths: string[] }>("/api/v1/models/faster-whisper/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model_name: modelName }),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Delete Whisper model"
  });
}
