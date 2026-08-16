import { API_TIMEOUTS, requestJson, type PreparedExport } from "./core";

export type PromptingProviderStatus = {
  id: string;
  name: string;
  installed: boolean;
  running: boolean;
  available: boolean;
  requires_auth: boolean;
  base_url: string;
  message: string;
  model_count: number;
};

export type PromptingProvidersPayload = {
  providers: PromptingProviderStatus[];
};

export type PromptingModel = {
  id: string;
  display_name: string;
  details: string;
  context_length: number | null;
  is_loaded: boolean;
};

export type PromptingModelsPayload = {
  provider_id: string;
  provider_name: string;
  models: PromptingModel[];
};

export type PromptAdvancedMapping = {
  text_column?: string;
  transcript_id_column?: string;
  speaker_column?: string;
  start_column?: string;
  end_column?: string;
};

export type PromptInputCandidateStatus = "ready" | "equivalent_format" | "mapping_required" | "problem";

export type PromptInputCandidate = {
  candidate_id: string;
  source_path: string;
  file_name: string;
  format: string;
  document_id: string;
  document_index: number;
  title: string;
  segment_count: number;
  content_fingerprint: string;
  status: PromptInputCandidateStatus;
  reason: string;
  recommended: boolean;
  equivalent_group: string | null;
  mapping_columns: string[];
  mapping: PromptAdvancedMapping;
};

export type PromptInputInspectResult = {
  input_mode: string;
  input_path: string;
  file_count: number;
  files: Array<{
    path: string;
    file_name: string;
    format: string;
    requires_mapping: boolean;
  }>;
  mapping: PromptAdvancedMapping;
  mapping_columns?: string[];
  mapping_required: boolean;
  candidate_count: number;
  counts: {
    ready: number;
    decisions_required: number;
    mapping_required: number;
    problems: number;
  };
  candidates: PromptInputCandidate[];
  problems: PromptInputCandidate[];
};

export type PromptCustomAnalysis = {
  id: string;
  name: string;
  instructions: string;
  output_key: string;
};

export type PromptCustomAnalysesPayload = {
  analyses: PromptCustomAnalysis[];
  analysis?: PromptCustomAnalysis;
  deleted_id?: string;
};

export type PromptAnalysisType = "overview" | "research_focus" | "interview_review" | "custom";

export type PromptAnalysisSelection = {
  type: PromptAnalysisType;
  name?: string;
  prompt: string;
  research_focus?: string;
  custom_analysis_id?: string;
};

export type PromptTemplateOption = {
  id: string;
  template_id: string;
  label: string;
  help_text: string;
  default_prompt: string;
  current_prompt: string;
  has_permanent_override: boolean;
};

export type PromptTemplateTask = {
  id: string;
  label: string;
  options: Record<string, PromptTemplateOption>;
};

export type PromptTemplateCatalog = {
  tasks: Record<string, PromptTemplateTask>;
};

export type PromptRunSnapshot = {
  run_id: string | null;
  status: string;
  message: string;
  progress_percent: number;
  started_at: string | null;
  finished_at: string | null;
  provider_id: string | null;
  provider_name?: string | null;
  model_id: string | null;
  log_file: string | null;
  input_mode?: string | null;
  input_path?: string | null;
  output_files?: PreparedExport[];
  transcripts_completed?: number;
  total_transcripts?: number;
  current_transcript_id?: string | null;
  current_task?: string | null;
  rows_generated?: number;
  error_message?: string | null;
  phase?: string;
  progress_kind?: "determinate" | "indeterminate";
  progress_completed?: number;
  progress_total?: number;
  progress_label?: string;
  exclusions?: Array<{ file_name: string; source_path: string; code: string; message: string }>;
  transcript_outcomes?: Array<{
    transcript_id: string;
    source_file: string;
    status: string;
    result_count: number;
    error: string;
  }>;
  warnings?: string[];
  counts: Record<string, number>;
};

export async function fetchPromptingProviders(refresh = false): Promise<PromptingProvidersPayload> {
  const query = refresh ? "?refresh=1" : "";
  return await requestJson<PromptingProvidersPayload>(`/api/v1/prompting/providers${query}`, {
    operation: "Transcript Analysis providers"
  });
}

export async function fetchPromptingModels(providerId: string): Promise<PromptingModelsPayload> {
  return await requestJson<PromptingModelsPayload>("/api/v1/prompting/models", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ provider_id: providerId }),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Transcript Analysis models"
  });
}

export async function fetchPromptTemplates(): Promise<PromptTemplateCatalog> {
  return await requestJson<PromptTemplateCatalog>("/api/v1/prompting/prompt-templates", {
    operation: "Prompt templates"
  });
}

export async function fetchPromptCustomAnalyses(): Promise<PromptCustomAnalysesPayload> {
  return await requestJson<PromptCustomAnalysesPayload>("/api/v1/prompting/custom-analyses", {
    operation: "Custom analyses"
  });
}

async function mutatePromptCustomAnalysis(
  action: "create" | "update" | "duplicate" | "delete",
  payload: Record<string, unknown>
): Promise<PromptCustomAnalysesPayload> {
  return await requestJson<PromptCustomAnalysesPayload>(`/api/v1/prompting/custom-analyses/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: `${action} custom analysis`
  });
}

export const createPromptCustomAnalysis = (payload: { name: string; instructions: string }) =>
  mutatePromptCustomAnalysis("create", payload);
export const updatePromptCustomAnalysis = (payload: { id: string; name: string; instructions: string }) =>
  mutatePromptCustomAnalysis("update", payload);
export const duplicatePromptCustomAnalysis = (id: string) => mutatePromptCustomAnalysis("duplicate", { id });
export const deletePromptCustomAnalysis = (id: string) => mutatePromptCustomAnalysis("delete", { id });

export async function savePromptTemplate(payload: {
  template_id: string;
  prompt_text: string;
}): Promise<PromptTemplateCatalog> {
  return await requestJson<PromptTemplateCatalog>("/api/v1/prompting/prompt-templates/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Save prompt template"
  });
}

export async function revertPromptTemplate(templateId: string): Promise<PromptTemplateCatalog> {
  return await requestJson<PromptTemplateCatalog>("/api/v1/prompting/prompt-templates/revert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ template_id: templateId }),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Reset prompt template"
  });
}

export async function inspectPromptInput(payload: {
  input_mode: string;
  input_path: string;
  candidate_mappings?: Record<string, PromptAdvancedMapping>;
}): Promise<PromptInputInspectResult> {
  return await requestJson<PromptInputInspectResult>("/api/v1/prompting/inspect-input", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Transcript Analysis input inspection"
  });
}

export async function fetchCurrentPromptRun(): Promise<PromptRunSnapshot> {
  return await requestJson<PromptRunSnapshot>("/api/v1/prompting/current-run", {
    timeoutMs: API_TIMEOUTS.health,
    operation: "Transcript Analysis status"
  });
}

export async function startPromptRun(payload: {
  provider_id: string;
  model_id: string;
  input_mode: string;
  input_path: string;
  advanced_mapping: PromptAdvancedMapping;
  tasks: Record<string, unknown>;
  temperature: number;
  timeout_seconds: number;
  output_folder: string;
  output_naming_mode: string;
  output_basename: string;
  output_formats: string[];
  selected_candidate_ids: string[];
  candidate_mappings?: Record<string, PromptAdvancedMapping>;
  analysis?: PromptAnalysisSelection;
}): Promise<PromptRunSnapshot> {
  return await requestJson<PromptRunSnapshot>("/api/v1/prompting/start-run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Start prompting run"
  });
}

export async function cancelPromptRun(): Promise<PromptRunSnapshot> {
  return await requestJson<PromptRunSnapshot>("/api/v1/prompting/cancel-run", {
    method: "POST",
    timeoutMs: API_TIMEOUTS.mutation,
    operation: "Stop prompting run"
  });
}
