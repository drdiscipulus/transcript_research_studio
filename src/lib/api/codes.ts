import { API_TIMEOUTS, ApiError, requestJson } from "./core";

export type CodesAiSettings = {
  provider_id: string;
  model_id: string;
  temperature: number;
  timeout_seconds: number;
  suggestion_language: "auto" | "english" | "german" | string;
  prompt_overrides?: {
    evidence: string;
    codes: string;
    note: string;
    codebook: string;
    themes: string;
  };
};

export type CodesAiRunTask =
  | "evidence"
  | "codes"
  | "note"
  | "code_details"
  | "code_refinement"
  | "theme_suggestions"
  | "theme_refinement";

export type CodesProvisionalCodeInput = {
  client_id: string;
  name: string;
  color: string;
  description?: string;
  inclusion_note?: string;
  exclusion_note?: string;
  example_evidence_ids?: string[];
  memo?: string;
  use_current_evidence_as_example?: boolean;
};

export type CodesAiRunRecord = {
  run_id: string;
  task: CodesAiRunTask;
  scope: Record<string, unknown>;
  context: Record<string, unknown>;
  researcher_prompt: string;
  system_prompt_version: string;
  provider_id: string;
  model_id: string;
  temperature: number;
  timeout_seconds: number;
  maximum_suggestions: number;
  created_at: string;
};

export type CodesAiDecisionInput = {
  run_id: string;
  suggestion_id: string;
  task: CodesAiRunTask;
  decision: "accepted" | "edited" | "rejected";
  target_reference?: string;
  result_ids?: string[];
  note?: string;
};

export type CodesProjectSettings = {
  case_definition: string;
  theme_assignment: string;
  memo_format: string;
  transcript_folder_import: string;
  ai_audit: string;
};

export type CodesTranscriptSegment = {
  segment_id: string;
  start: number | null;
  end: number | null;
  speaker: string;
  text: string;
};

export type CodesTranscript = {
  transcript_id: string;
  label: string;
  source_file: string;
  source_document_id: string;
  imported_at: string;
  refreshed_at: string | null;
  language: string;
  speakers: Array<{ id: string; name: string }>;
  segments: CodesTranscriptSegment[];
  metadata: Record<string, unknown>;
  validation_issues: unknown[];
};

export type CodesEvidenceItem = {
  evidence_id: string;
  transcript_id: string;
  source_file: string;
  source_document_id: string;
  segment_ids: string[];
  speaker: string;
  start: number | null;
  end: number | null;
  selected_text: string;
  segment_ranges: Record<string, CodesEvidenceSegmentRange>;
  code_ids: string[];
  memo: string;
  created_at: string;
  updated_at: string;
};

export type CodesEvidenceSegmentRange = {
  start_offset: number;
  end_offset: number;
  excerpt: string;
};

export type CodesCode = {
  code_id: string;
  name: string;
  description: string;
  inclusion_note: string;
  exclusion_note: string;
  example_evidence_ids: string[];
  color: string;
  memo: string;
  created_at: string;
  updated_at: string;
};

export type CodesTheme = {
  theme_id: string;
  name: string;
  description: string;
  color: string;
  code_ids: string[];
  memo: string;
  created_at: string;
  updated_at: string;
};

export type CodesReportDraft = {
  draft_id: string;
  title: string;
  body: string;
  source_suggestion_id: string;
  created_at: string;
  updated_at: string;
};

export type CodesProject = {
  schema_version: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  research_focus: string;
  ai_settings: CodesAiSettings;
  transcripts: CodesTranscript[];
  evidence_items: CodesEvidenceItem[];
  codes: CodesCode[];
  themes: CodesTheme[];
  report_drafts: CodesReportDraft[];
  suggestion_decisions: Array<Record<string, unknown>>;
  ai_runs?: CodesAiRunRecord[];
  settings: CodesProjectSettings;
  id_counters: Record<string, number>;
};

export type CodesProjectHandle = {
  project_file: string;
  project_id: string;
  revision: string;
};

type CodesProjectScalarPatch = Partial<
  Omit<
    CodesProject,
    "transcripts" | "evidence_items" | "codes" | "themes" | "report_drafts" | "suggestion_decisions" | "ai_runs"
  >
>;

export type CodesProjectPatch = {
  set?: CodesProjectScalarPatch;
  upsert?: {
    transcripts?: CodesTranscript[];
    evidence_items?: CodesEvidenceItem[];
    codes?: CodesCode[];
    themes?: CodesTheme[];
    report_drafts?: CodesReportDraft[];
    suggestion_decisions?: Array<Record<string, unknown>>;
    ai_runs?: CodesAiRunRecord[];
  };
  remove?: {
    transcripts?: string[];
    evidence_items?: string[];
    codes?: string[];
    themes?: string[];
    report_drafts?: string[];
    suggestion_decisions?: string[];
    ai_runs?: string[];
  };
};

export type CodesProjectPayload = CodesProjectHandle & {
  project: CodesProject;
  handle: CodesProjectHandle;
};

type CodesMutationMetadata = CodesProjectHandle & {
  project: CodesProject;
  handle: CodesProjectHandle;
  project_patch?: CodesProjectPatch;
};

export type CodesExportProduct = "xlsx" | "csv" | "json" | "docx" | "qdpx";
export type CodesDocxMode = "separate" | "combined";

export type CodesExportArtifact = {
  product: CodesExportProduct | "bundle";
  role: string;
  archive_path: string;
  size: number;
};

export type CodesExportBundlePayload = {
  bundle: { path: string; exists: boolean; size: number };
  artifacts: CodesExportArtifact[];
  warnings: string[];
  manifest: Record<string, unknown>;
};

export type TranscriptImportCandidateStatus = "ready" | "already_imported" | "alternate_format" | "problem";

export type TranscriptImportCandidate = {
  candidate_id: string;
  source_path: string;
  source_document_id: string;
  document_index: number;
  format: "json" | "xlsx" | "csv" | "docx" | string;
  logical_fingerprint: string;
  logical_group: string;
  title: string;
  segment_count: number;
  status: TranscriptImportCandidateStatus;
  preferred: boolean;
  reason: string;
};

export type TranscriptImportPreview = CodesProjectHandle & {
  candidates: TranscriptImportCandidate[];
  counts: {
    ready: number;
    already_imported: number;
    alternate_format: number;
    problem: number;
  };
  non_recursive: boolean;
};

export type TranscriptImportResult = CodesMutationMetadata & {
  imported: CodesTranscript[];
  skipped: Array<{ candidate_id: string; source_path: string; source_document_id: string; reason: string }>;
  failed: Array<{ candidate_id: string; source_path: string; source_document_id: string; reason: string }>;
};

export type CodesRemoveTranscriptPayload = CodesMutationMetadata & { transcript_id: string; label: string };
export type CodesEvidencePayload = CodesMutationMetadata & { evidence: CodesEvidenceItem; created_codes?: Array<CodesCode & { client_id?: string }> };
export type CodesDeleteEvidencePayload = CodesMutationMetadata & { evidence_id: string };
export type CodesCodePayload = CodesMutationMetadata & { code: CodesCode };
export type CodesDeleteCodePayload = CodesMutationMetadata & { code_id: string };
export type CodesMergeCodePayload = CodesMutationMetadata & { source_code_id: string; target_code: CodesCode };
export type CodesThemePayload = CodesMutationMetadata & { theme: CodesTheme };
export type CodesDeleteThemePayload = CodesMutationMetadata & { theme_id: string };
export type CodesAiDecisionPayload = CodesMutationMetadata & {
  decision: {
    decision_id: string;
    suggestion_id: string;
    task: string;
    decision: string;
    result_ids: string[];
    note: string;
    provider_id: string;
    model_id: string;
    created_at: string;
  };
};

export type CodesAiEvidenceSuggestion = {
  suggestion_id: string;
  run_id: string;
  kind: "evidence";
  transcript_id: string;
  segment_ids: string[];
  segment_ranges: Record<string, CodesEvidenceSegmentRange>;
  selected_text: string;
  speaker: string;
  start: number | null;
  end: number | null;
  rationale: string;
};

export type CodesAiCodeSuggestion = {
  suggestion_id: string;
  kind: "existing_code" | "new_code";
  code_id?: string;
  name: string;
  description: string;
  rationale: string;
};

export type CodesAiNoteSuggestion = {
  suggestion_id: string;
  kind: "note";
  note: string;
};

export type CodesAiCodeDetailsSuggestion = {
  suggestion_id: string;
  run_id: string;
  kind: "code_details" | "code_refinement";
  code_id?: string;
  name: string;
  description: string;
  inclusion_note: string;
  exclusion_note: string;
  memo: string;
  rationale?: string;
};

export type CodesAiThemeSuggestion = {
  suggestion_id: string;
  run_id: string;
  kind: "theme_suggestion" | "theme_refinement";
  theme_id?: string;
  name?: string;
  description: string;
  memo: string;
  code_ids: string[];
  rationale: string;
};

export type CodesContextualAiSuggestion =
  | CodesAiEvidenceSuggestion
  | CodesAiCodeSuggestion
  | CodesAiNoteSuggestion
  | CodesAiCodeDetailsSuggestion
  | CodesAiThemeSuggestion;

export type CodesAiRunStatus =
  | "pending"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type CodesAiRunSnapshot = {
  run_id: string;
  project_id: string;
  task: CodesAiRunTask;
  status: CodesAiRunStatus;
  phase: "queued" | "preparing" | "requesting" | "validating" | "completed" | "cancelled" | "failed";
  progress_kind: "determinate" | "indeterminate";
  progress_label: string;
  message: string;
  progress_completed: number;
  progress_total: number;
  results: CodesContextualAiSuggestion[];
  omitted: Array<{ reason: string }>;
  error: string;
  started_at: string;
  finished_at: string | null;
};

export type CodesAiRunMutationPayload = CodesMutationMetadata & { run: CodesAiRunSnapshot };

export type CodesAiRunStartPayload = {
  project: CodesProject;
  handle: CodesProjectHandle;
  task: CodesAiRunTask;
  researcher_prompt: string;
  maximum_suggestions?: number;
  scope?: Record<string, unknown>;
  transcript_id?: string;
  segment_ids?: string[];
  evidence_id?: string;
  selected_text?: string;
  code_ids?: string[];
  code_id?: string;
  theme_id?: string;
  selected_code_ids?: string[];
  code_draft?: Record<string, unknown>;
  theme_draft?: Record<string, unknown>;
};

type CodesMutationWirePayload = Partial<CodesProjectHandle> & {
  project?: CodesProject;
  project_patch?: CodesProjectPatch;
  [key: string]: unknown;
};

export class CodesProjectConflictError extends ApiError {
  readonly code = "project_conflict";
  readonly currentRevision: string;

  constructor(source: ApiError, currentRevision = "") {
    super({
      message: source.message,
      kind: source.kind,
      status: source.status,
      errorCode: source.errorCode,
      requestId: source.requestId,
      retryable: source.retryable,
      details: source.details,
      cause: source.originalCause
    });
    this.name = "CodesProjectConflictError";
    this.currentRevision = currentRevision;
  }
}

function rethrowCodesRequestError(error: unknown, fallbackMessage: string): never {
  if (error instanceof ApiError) {
    const currentRevision = typeof error.details?.current_revision === "string"
      ? error.details.current_revision
      : "";
    if (error.status === 409 && error.errorCode === "project_conflict") {
      throw new CodesProjectConflictError(error, currentRevision);
    }
    throw error;
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(fallbackMessage);
}

async function postCodesJson<T>(
  endpoint: string,
  payload: Record<string, unknown>,
  operation: string,
  timeoutMs: number = API_TIMEOUTS.mutation
): Promise<T> {
  try {
    return await requestJson<T>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs,
      operation
    });
  } catch (error) {
    rethrowCodesRequestError(error, `${operation} failed.`);
  }
}

function requireHandle(payload: Partial<CodesProjectHandle>, fallbackFile = ""): CodesProjectHandle {
  const projectFile = payload.project_file ?? fallbackFile;
  if (!projectFile || !payload.project_id || !payload.revision) {
    throw new ApiError({
      message: "The Python service is too old for conflict-safe Codes projects. Restart or update the app.",
      kind: "invalid_response",
      retryable: false
    });
  }
  return { project_file: projectFile, project_id: payload.project_id, revision: payload.revision };
}

function handleBody(handle: CodesProjectHandle) {
  return {
    project_file: handle.project_file,
    project_id: handle.project_id,
    expected_revision: handle.revision
  };
}

function patchRecords<T extends Record<string, unknown>>(
  current: T[],
  changed: T[] | undefined,
  removed: string[] | undefined,
  idField: keyof T
): T[] {
  const removedIds = new Set(removed ?? []);
  const changedById = new Map((changed ?? []).map((record) => [String(record[idField] ?? ""), record]));
  const next = current
    .filter((record) => !removedIds.has(String(record[idField] ?? "")))
    .map((record) => changedById.get(String(record[idField] ?? "")) ?? record);
  const existingIds = new Set(next.map((record) => String(record[idField] ?? "")));
  for (const record of changed ?? []) {
    if (!existingIds.has(String(record[idField] ?? ""))) {
      next.push(record);
    }
  }
  return next;
}

export function applyCodesProjectPatch(project: CodesProject, patch?: CodesProjectPatch): CodesProject {
  if (!patch) return project;
  const next = { ...project, ...(patch.set ?? {}) };
  next.transcripts = patchRecords(
    project.transcripts as Array<CodesTranscript & Record<string, unknown>>,
    patch.upsert?.transcripts as Array<CodesTranscript & Record<string, unknown>> | undefined,
    patch.remove?.transcripts,
    "transcript_id"
  );
  next.evidence_items = patchRecords(
    project.evidence_items as Array<CodesEvidenceItem & Record<string, unknown>>,
    patch.upsert?.evidence_items as Array<CodesEvidenceItem & Record<string, unknown>> | undefined,
    patch.remove?.evidence_items,
    "evidence_id"
  );
  next.codes = patchRecords(
    project.codes as Array<CodesCode & Record<string, unknown>>,
    patch.upsert?.codes as Array<CodesCode & Record<string, unknown>> | undefined,
    patch.remove?.codes,
    "code_id"
  );
  next.themes = patchRecords(
    project.themes as Array<CodesTheme & Record<string, unknown>>,
    patch.upsert?.themes as Array<CodesTheme & Record<string, unknown>> | undefined,
    patch.remove?.themes,
    "theme_id"
  );
  next.report_drafts = patchRecords(
    project.report_drafts as Array<CodesReportDraft & Record<string, unknown>>,
    patch.upsert?.report_drafts as Array<CodesReportDraft & Record<string, unknown>> | undefined,
    patch.remove?.report_drafts,
    "draft_id"
  );
  next.suggestion_decisions = patchRecords(
    project.suggestion_decisions,
    patch.upsert?.suggestion_decisions,
    patch.remove?.suggestion_decisions,
    "decision_id"
  );
  next.ai_runs = patchRecords(
    (project.ai_runs ?? []) as Array<CodesAiRunRecord & Record<string, unknown>>,
    patch.upsert?.ai_runs as Array<CodesAiRunRecord & Record<string, unknown>> | undefined,
    patch.remove?.ai_runs,
    "run_id"
  );
  return next;
}

function parseProjectResponse(payload: { project: CodesProject } & Partial<CodesProjectHandle>): CodesProjectPayload {
  const handle = requireHandle(payload);
  return { ...payload, ...handle, handle };
}

async function postMutation<T extends object>(
  endpoint: string,
  project: CodesProject,
  handle: CodesProjectHandle,
  changes: Record<string, unknown>,
  operation: string
): Promise<T & CodesMutationMetadata> {
  const wire = await postCodesJson<CodesMutationWirePayload>(
    endpoint,
    { ...handleBody(handle), ...changes },
    operation,
    API_TIMEOUTS.mutation
  );
  const nextHandle = requireHandle(wire, handle.project_file);
  const nextProject = wire.project ?? applyCodesProjectPatch(project, wire.project_patch);
  return { ...wire, ...nextHandle, handle: nextHandle, project: nextProject } as T & CodesMutationMetadata;
}

export async function createCodesProject(payload: {
  project_file: string;
  name?: string;
  research_focus?: string;
  ai_settings?: Partial<CodesAiSettings>;
}): Promise<CodesProjectPayload> {
  const response = await postCodesJson<{ project: CodesProject } & Partial<CodesProjectHandle>>(
    "/api/v1/codes/project/create",
    payload,
    "Codes project create"
  );
  return parseProjectResponse(response);
}

export async function loadCodesProject(projectFile: string): Promise<CodesProjectPayload> {
  const response = await postCodesJson<{ project: CodesProject } & Partial<CodesProjectHandle>>(
    "/api/v1/codes/project/load",
    { project_file: projectFile },
    "Codes project load",
    API_TIMEOUTS.scan
  );
  return parseProjectResponse(response);
}

export async function saveCodesProject(
  projectFile: string,
  project: CodesProject,
  handle: CodesProjectHandle
): Promise<CodesProjectPayload> {
  const wire = await postCodesJson<CodesMutationWirePayload>(
    "/api/v1/codes/project/save",
    {
      project_file: projectFile,
      source_project_file: handle.project_file,
      project_id: handle.project_id,
      expected_revision: handle.revision,
      project_updates: {
        name: project.name,
        research_focus: project.research_focus,
        ai_settings: project.ai_settings,
        settings: project.settings
      }
    },
    "Codes project save",
    API_TIMEOUTS.scan
  );
  const nextHandle = requireHandle(wire, projectFile);
  return {
    ...nextHandle,
    handle: nextHandle,
    project: wire.project ?? applyCodesProjectPatch(project, wire.project_patch)
  };
}

export async function exportCodesProjectBundle(payload: {
  handle: CodesProjectHandle;
  output_file: string;
  products: CodesExportProduct[];
  docx_mode: CodesDocxMode;
  include_local_paths: boolean;
  include_ai_audit: boolean;
}): Promise<CodesExportBundlePayload> {
  const { handle, ...changes } = payload;
  return await postCodesJson<CodesExportBundlePayload>(
    "/api/v1/codes/project/export-bundle",
    { ...handleBody(handle), ...changes },
    "Coding project export bundle",
    API_TIMEOUTS.longMutation
  );
}

export async function previewCodesTranscriptImport(payload: {
  handle: CodesProjectHandle;
  transcript_file?: string;
  transcript_folder?: string;
}): Promise<TranscriptImportPreview> {
  const { handle, ...changes } = payload;
  return await postCodesJson<TranscriptImportPreview>(
    "/api/v1/codes/project/preview-transcript-import",
    { ...handleBody(handle), ...changes },
    "Transcript import preview",
    API_TIMEOUTS.longMutation
  );
}

export function importCodesTranscriptCandidates(payload: {
  project: CodesProject;
  handle: CodesProjectHandle;
  candidates: Array<{
    candidate_id: string;
    source_path: string;
    source_document_id: string;
    allow_duplicate?: boolean;
  }>;
}) {
  const { project, handle, candidates } = payload;
  return postMutation<Pick<TranscriptImportResult, "imported" | "skipped" | "failed">>(
    "/api/v1/codes/project/import-transcripts",
    project,
    handle,
    { candidates },
    "Transcript import"
  ) as Promise<TranscriptImportResult>;
}

export function removeCodesProjectTranscript(project: CodesProject, handle: CodesProjectHandle, transcriptId: string) {
  return postMutation<{ transcript_id: string; label: string }>(
    "/api/v1/codes/project/remove-transcript",
    project,
    handle,
    { transcript_id: transcriptId },
    "Transcript removal"
  ) as Promise<CodesRemoveTranscriptPayload>;
}

export function createCodesEvidenceItem(payload: {
  project: CodesProject; handle: CodesProjectHandle; transcript_id: string; segment_ids: string[];
  selected_text: string; segment_ranges: Record<string, CodesEvidenceSegmentRange>; code_ids?: string[]; memo?: string;
  new_codes?: CodesProvisionalCodeInput[];
  ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ evidence: CodesEvidenceItem }>(
    "/api/v1/codes/project/create-evidence", project, handle, changes, "Evidence create"
  ) as Promise<CodesEvidencePayload>;
}

export function updateCodesEvidenceItem(payload: {
  project: CodesProject; handle: CodesProjectHandle; evidence_id: string; selected_text?: string; code_ids?: string[]; memo?: string;
  new_codes?: CodesProvisionalCodeInput[];
  ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ evidence: CodesEvidenceItem }>(
    "/api/v1/codes/project/update-evidence", project, handle, changes, "Evidence update"
  ) as Promise<CodesEvidencePayload>;
}

export function deleteCodesEvidenceItem(project: CodesProject, handle: CodesProjectHandle, evidenceId: string) {
  return postMutation<{ evidence_id: string }>(
    "/api/v1/codes/project/delete-evidence", project, handle, { evidence_id: evidenceId }, "Evidence delete"
  ) as Promise<CodesDeleteEvidencePayload>;
}

export function createCodesCode(payload: {
  project: CodesProject; handle: CodesProjectHandle; name: string; description?: string; inclusion_note?: string;
  exclusion_note?: string; example_evidence_ids?: string[]; color?: string; memo?: string; ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ code: CodesCode }>(
    "/api/v1/codes/project/create-code", project, handle, changes, "Code create"
  ) as Promise<CodesCodePayload>;
}

export function updateCodesCode(payload: {
  project: CodesProject; handle: CodesProjectHandle; code_id: string; name?: string; description?: string;
  inclusion_note?: string; exclusion_note?: string; example_evidence_ids?: string[]; color?: string; memo?: string; ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ code: CodesCode }>(
    "/api/v1/codes/project/update-code", project, handle, changes, "Code update"
  ) as Promise<CodesCodePayload>;
}

export function deleteCodesCode(project: CodesProject, handle: CodesProjectHandle, codeId: string) {
  return postMutation<{ code_id: string }>(
    "/api/v1/codes/project/delete-code", project, handle, { code_id: codeId }, "Code delete"
  ) as Promise<CodesDeleteCodePayload>;
}

export function mergeCodesCode(
  project: CodesProject,
  handle: CodesProjectHandle,
  sourceCodeId: string,
  targetCodeId: string,
  mergedFields?: { description?: string; inclusion_note?: string; exclusion_note?: string; memo?: string }
) {
  return postMutation<{ source_code_id: string; target_code: CodesCode }>(
    "/api/v1/codes/project/merge-code", project, handle,
    { source_code_id: sourceCodeId, target_code_id: targetCodeId, ...mergedFields }, "Code merge"
  ) as Promise<CodesMergeCodePayload>;
}

export function createCodesTheme(payload: {
  project: CodesProject; handle: CodesProjectHandle; name: string; description?: string; color?: string; code_ids?: string[]; memo?: string; ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ theme: CodesTheme }>(
    "/api/v1/codes/project/create-theme", project, handle, changes, "Theme create"
  ) as Promise<CodesThemePayload>;
}

export function updateCodesTheme(payload: {
  project: CodesProject; handle: CodesProjectHandle; theme_id: string; name?: string; description?: string;
  color?: string; code_ids?: string[]; memo?: string; ai_decisions?: CodesAiDecisionInput[];
}) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ theme: CodesTheme }>(
    "/api/v1/codes/project/update-theme", project, handle, changes, "Theme update"
  ) as Promise<CodesThemePayload>;
}

export function deleteCodesTheme(project: CodesProject, handle: CodesProjectHandle, themeId: string) {
  return postMutation<{ theme_id: string }>(
    "/api/v1/codes/project/delete-theme", project, handle, { theme_id: themeId }, "Theme delete"
  ) as Promise<CodesDeleteThemePayload>;
}

export function startCodesAiRun(payload: CodesAiRunStartPayload) {
  const { project, handle, ...changes } = payload;
  return postMutation<{ run: CodesAiRunSnapshot }>(
    "/api/v1/codes/project/ai-run/start",
    project,
    handle,
    changes,
    "AI assistance"
  ) as Promise<CodesAiRunMutationPayload>;
}

export async function fetchCodesAiRun(projectId: string, runId: string): Promise<CodesAiRunSnapshot> {
  const payload = await postCodesJson<{ run: CodesAiRunSnapshot }>(
    "/api/v1/codes/project/ai-run/status",
    { project_id: projectId, run_id: runId },
    "AI assistance status",
    API_TIMEOUTS.health
  );
  return payload.run;
}

export async function cancelCodesAiRun(projectId: string, runId: string): Promise<CodesAiRunSnapshot> {
  const payload = await postCodesJson<{ run: CodesAiRunSnapshot }>(
    "/api/v1/codes/project/ai-run/cancel",
    { project_id: projectId, run_id: runId },
    "AI assistance cancel"
  );
  return payload.run;
}

export function recordCodesContextualAiDecision(payload: {
  project: CodesProject;
  handle: CodesProjectHandle;
  run_id: string;
  suggestion_id: string;
  task: CodesAiRunTask;
  decision: "accepted" | "edited" | "rejected";
  target_reference?: string;
  result_ids?: string[];
  note?: string;
}) {
  const { project, handle, suggestion_id, task, ...changes } = payload;
  return postMutation<{ decision: CodesAiDecisionPayload["decision"] }>(
    "/api/v1/codes/project/suggestion-decision",
    project,
    handle,
    {
      ...changes,
      suggestion: { suggestion_id, task, run_id: changes.run_id },
      suggestion_id,
      task
    },
    "AI decision save"
  ) as Promise<CodesAiDecisionPayload>;
}
