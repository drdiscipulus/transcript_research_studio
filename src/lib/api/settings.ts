import { API_TIMEOUTS, requestJson } from "./core";

export type AppSettings = {
  theme_override: string;
  advanced_transcription: {
    diarization_enabled: boolean;
    include_timestamps: boolean;
    beam_size: number;
    vad_filter: boolean;
    temperature: number;
    compute_type: string;
    speaker_mode: string;
    exact_speakers: number | null;
    min_speakers: number | null;
    max_speakers: number | null;
  };
};

export async function fetchAppSettings(): Promise<AppSettings> {
  return await requestJson<AppSettings>("/api/v1/settings", { operation: "Settings" });
}

export async function saveAppSettings(payload: {
  theme_override?: string;
  advanced_transcription?: AppSettings["advanced_transcription"];
}): Promise<AppSettings> {
  return await requestJson<AppSettings>("/api/v1/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Save settings"
  });
}

export async function resetAppSettings(): Promise<AppSettings> {
  return await requestJson<AppSettings>("/api/v1/settings/reset", {
    method: "POST",
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Reset settings"
  });
}
