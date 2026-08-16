import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  CodesProjectConflictError,
  type CodesAiDecisionPayload,
  type CodesAiRunSnapshot,
  type CodesEvidencePayload,
  type CodesExportBundlePayload,
  type CodesProject,
  type CodesProjectHandle,
  type PromptingProviderStatus,
  type TranscriptImportPreview,
  type TranscriptImportResult
} from "../../src/lib/api";
import { CodesPage } from "../../src/components/CodesPage";
import { WorkbenchLifecycleProvider, useWorkbenchLifecycle } from "../../src/components/workbench/WorkbenchLifecycle";

const apiMocks = vi.hoisted(() => ({
  pickProject: vi.fn(),
  pickProjectSaveFile: vi.fn(),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
  updateCode: vi.fn(),
  updateTheme: vi.fn(),
  updateEvidence: vi.fn(),
  deleteEvidence: vi.fn(),
  recordAiDecision: vi.fn(),
  fetchProviders: vi.fn(),
  fetchModels: vi.fn(),
  refreshProviders: vi.fn(),
  startAiRun: vi.fn(),
  fetchAiRun: vi.fn(),
  cancelAiRun: vi.fn(),
  removeTranscript: vi.fn(),
  pickTranscriptFile: vi.fn(),
  pickTranscriptFolder: vi.fn(),
  previewTranscriptImport: vi.fn(),
  importTranscriptCandidates: vi.fn(),
  pickExportBundleFile: vi.fn(),
  exportProjectBundle: vi.fn(),
  openPath: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    pickEvidenceProjectFile: apiMocks.pickProject,
    pickEvidenceProjectSaveFile: apiMocks.pickProjectSaveFile,
    loadCodesProject: apiMocks.loadProject,
    saveCodesProject: apiMocks.saveProject,
    updateCodesCode: apiMocks.updateCode,
    updateCodesTheme: apiMocks.updateTheme,
    updateCodesEvidenceItem: apiMocks.updateEvidence,
    deleteCodesEvidenceItem: apiMocks.deleteEvidence,
    recordCodesContextualAiDecision: apiMocks.recordAiDecision,
    fetchPromptingProviders: apiMocks.fetchProviders,
    fetchPromptingModels: apiMocks.fetchModels,
    startCodesAiRun: apiMocks.startAiRun,
    fetchCodesAiRun: apiMocks.fetchAiRun,
    cancelCodesAiRun: apiMocks.cancelAiRun,
    removeCodesProjectTranscript: apiMocks.removeTranscript,
    pickTranscriptFile: apiMocks.pickTranscriptFile,
    pickFolder: apiMocks.pickTranscriptFolder,
    previewCodesTranscriptImport: apiMocks.previewTranscriptImport,
    importCodesTranscriptCandidates: apiMocks.importTranscriptCandidates,
    pickCodesExportBundleFile: apiMocks.pickExportBundleFile,
    exportCodesProjectBundle: apiMocks.exportProjectBundle,
    openPath: apiMocks.openPath
  };
});

const project: CodesProject = {
  schema_version: "1.1",
  project_id: "project_test",
  name: "Founder Interviews",
  created_at: "2026-07-18T12:00:00Z",
  updated_at: "2026-07-18T12:00:00Z",
  research_focus: "Founder responses to uncertainty",
  ai_settings: {
    provider_id: "",
    model_id: "",
    temperature: 0,
    timeout_seconds: 180,
    suggestion_language: "auto"
  },
  transcripts: [],
  evidence_items: [],
  codes: [],
  themes: [],
  report_drafts: [],
  suggestion_decisions: [],
  settings: {
    case_definition: "transcript",
    theme_assignment: "multiple",
    memo_format: "plain_text",
    transcript_folder_import: "non_recursive",
    ai_audit: "decisions_only"
  },
  id_counters: {}
};

const handle: CodesProjectHandle = {
  project_file: "D:\\research\\founders.evidence.json",
  project_id: project.project_id,
  revision: "a".repeat(64)
};

const exportBundlePayload: CodesExportBundlePayload = {
  bundle: { path: "D:\\exports\\founders_export.zip", exists: true, size: 4096 },
  artifacts: [{
    product: "xlsx",
    role: "analysis_workbook",
    archive_path: "analysis_workbook.xlsx",
    size: 2048
  }],
  warnings: [],
  manifest: { schema_version: "1.0" }
};

const availableProviders: PromptingProviderStatus[] = [
  {
    id: "lmstudio",
    name: "LM Studio",
    installed: true,
    running: true,
    available: true,
    requires_auth: false,
    base_url: "http://127.0.0.1:1234",
    message: "",
    model_count: 1
  },
  {
    id: "ollama",
    name: "Ollama",
    installed: true,
    running: true,
    available: true,
    requires_auth: false,
    base_url: "http://127.0.0.1:11434",
    message: "",
    model_count: 1
  }
];

function makeAiRun(overrides: Partial<CodesAiRunSnapshot> = {}): CodesAiRunSnapshot {
  return {
    run_id: "run_codes_1",
    project_id: project.project_id,
    task: "codes",
    status: "running",
    phase: "requesting",
    progress_kind: "indeterminate",
    progress_label: "Waiting for local model",
    message: "Waiting for local model",
    progress_completed: 0,
    progress_total: 0,
    results: [],
    omitted: [],
    error: "",
    started_at: "2026-07-18T12:00:00Z",
    finished_at: null,
    ...overrides
  };
}

function makeAiDecisionPayload({
  sourceProject,
  sourceHandle,
  suggestionId = "suggestion_codes_1",
  task = "codes"
}: {
  sourceProject: CodesProject;
  sourceHandle: CodesProjectHandle;
  suggestionId?: string;
  task?: string;
}): CodesAiDecisionPayload {
  const nextHandle = { ...sourceHandle, revision: "e".repeat(64) };
  return {
    ...nextHandle,
    project: sourceProject,
    handle: nextHandle,
    decision: {
      decision_id: `decision_${suggestionId}`,
      suggestion_id: suggestionId,
      task,
      decision: "rejected",
      result_ids: [],
      note: "",
      provider_id: sourceProject.ai_settings.provider_id,
      model_id: sourceProject.ai_settings.model_id,
      created_at: "2026-07-18T12:01:00Z"
    }
  };
}

function makeProjectConflict(message = "The coding project changed on disk.") {
  return new CodesProjectConflictError(new ApiError({
    message,
    kind: "http",
    status: 409,
    errorCode: "project_conflict",
    retryable: true
  }), "z".repeat(64));
}

function makeUpdatedEvidencePayload(request: {
  project: CodesProject;
  handle: CodesProjectHandle;
  evidence_id: string;
  memo?: string;
  code_ids?: string[];
}, revision = "c"): CodesEvidencePayload {
  const currentEvidence = request.project.evidence_items.find((item) => item.evidence_id === request.evidence_id);
  if (!currentEvidence) throw new Error("Expected evidence fixture.");
  const evidence = {
    ...currentEvidence,
    memo: request.memo ?? currentEvidence.memo,
    code_ids: request.code_ids ?? currentEvidence.code_ids,
    updated_at: "2026-07-18T12:01:00Z"
  };
  const updatedProject = {
    ...request.project,
    evidence_items: request.project.evidence_items.map((item) => item.evidence_id === evidence.evidence_id ? evidence : item)
  };
  const nextHandle = { ...request.handle, revision: revision.repeat(64) };
  return {
    ...nextHandle,
    project: updatedProject,
    handle: nextHandle,
    evidence,
    created_codes: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const projectWithEvidence: CodesProject = {
  ...project,
  transcripts: [{
    transcript_id: "T000001",
    label: "Founder Interview",
    source_file: "D:\\research\\founder.json",
    source_document_id: "doc_000001",
    imported_at: "2026-07-18T12:00:00Z",
    refreshed_at: null,
    language: "en",
    speakers: [{ id: "SPEAKER_00", name: "Founder" }],
    segments: [{ segment_id: "seg_000001", start: 0, end: 4, speaker: "SPEAKER_00", text: "Founder uncertainty" }],
    metadata: {},
    validation_issues: []
  }],
  evidence_items: [{
    evidence_id: "E000001",
    transcript_id: "T000001",
    source_file: "D:\\research\\founder.json",
    source_document_id: "doc_000001",
    segment_ids: ["seg_000001"],
    speaker: "SPEAKER_00",
    start: 0,
    end: 4,
    selected_text: "Founder uncertainty",
    segment_ranges: { seg_000001: { start_offset: 0, end_offset: 19, excerpt: "Founder uncertainty" } },
    code_ids: ["C000001"],
    memo: "",
    created_at: "2026-07-18T12:00:00Z",
    updated_at: "2026-07-18T12:00:00Z"
  }],
  codes: [{
    code_id: "C000001",
    name: "Uncertainty",
    description: "",
    inclusion_note: "",
    exclusion_note: "",
    example_evidence_ids: [],
    color: "#123456",
    memo: "",
    created_at: "2026-07-18T12:00:00Z",
    updated_at: "2026-07-18T12:00:00Z"
  }]
};

const projectWithTheme: CodesProject = {
  ...projectWithEvidence,
  themes: [{
    theme_id: "TH000001",
    name: "Interview Setup",
    description: "",
    color: "#654321",
    code_ids: ["C000001"],
    memo: "",
    created_at: "2026-07-18T12:00:00Z",
    updated_at: "2026-07-18T12:00:00Z"
  }]
};

const importCandidate = {
  candidate_id: "candidate_imported",
  source_path: "D:\\research\\imported.json",
  source_document_id: "doc_imported",
  document_index: 0,
  format: "json",
  logical_fingerprint: "fingerprint_imported",
  logical_group: "group_imported",
  title: "Imported Interview",
  segment_count: 1,
  status: "ready" as const,
  preferred: true,
  reason: ""
};

const importPreview: TranscriptImportPreview = {
  ...handle,
  candidates: [importCandidate],
  counts: { ready: 1, already_imported: 0, alternate_format: 0, problem: 0 },
  non_recursive: true
};

const importedTranscript = {
  ...projectWithEvidence.transcripts[0],
  transcript_id: "T000002",
  label: "Imported Interview",
  source_file: importCandidate.source_path,
  source_document_id: importCandidate.source_document_id,
  segments: [{
    segment_id: "seg_imported",
    start: 0,
    end: 3,
    speaker: "SPEAKER_00",
    text: "Imported transcript text"
  }]
};

function successfulImportPayload(baseProject: CodesProject): TranscriptImportResult {
  const nextHandle = { ...handle, revision: "d".repeat(64) };
  const nextProject = {
    ...baseProject,
    transcripts: [...baseProject.transcripts, importedTranscript]
  };
  return {
    ...nextHandle,
    project: nextProject,
    handle: nextHandle,
    imported: [importedTranscript],
    skipped: [],
    failed: []
  };
}

function WorkbenchProbe() {
  const { pageStates } = useWorkbenchLifecycle();
  return <output data-testid="codes-workbench-state">{JSON.stringify(pageStates.codes)}</output>;
}

function renderPage({
  providers = availableProviders,
  providersLoading = false,
  providerError = null,
  onRefreshProviders = apiMocks.refreshProviders
}: {
  providers?: PromptingProviderStatus[];
  providersLoading?: boolean;
  providerError?: string | null;
  onRefreshProviders?: () => void | Promise<void>;
} = {}) {
  return render(
    <WorkbenchLifecycleProvider>
      <CodesPage
        providers={providers}
        providersLoading={providersLoading}
        providerError={providerError}
        onRefreshProviders={onRefreshProviders}
      />
      <WorkbenchProbe />
    </WorkbenchLifecycleProvider>
  );
}

function prepareCompletedCodeSuggestionRun() {
  const configuredProject = {
    ...projectWithEvidence,
    ai_settings: {
      ...projectWithEvidence.ai_settings,
      provider_id: "lmstudio",
      model_id: "local-model"
    }
  };
  apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
  apiMocks.startAiRun.mockImplementation(async (payload) => ({
    project: payload.project,
    handle: payload.handle,
    run: makeAiRun()
  }));
  apiMocks.fetchAiRun.mockResolvedValue(makeAiRun({
    status: "completed",
    phase: "completed",
    progress_kind: "determinate",
    progress_label: "Completed",
    message: "Completed",
    progress_completed: 1,
    progress_total: 1,
    results: [{
      suggestion_id: "suggestion_codes_1",
      kind: "existing_code",
      code_id: "C000001",
      name: "Suggested Fit",
      description: "",
      rationale: "Matches the current definition."
    }],
    finished_at: "2026-07-18T12:00:01Z"
  }));
  return configuredProject;
}

function prepareCompletedEvidenceSuggestionRun() {
  const transcriptA = projectWithEvidence.transcripts[0];
  const transcriptB = {
    ...transcriptA,
    transcript_id: "T000002",
    label: "Founder Interview B",
    source_file: "D:\\research\\founder_b.json",
    source_document_id: "doc_000002",
    segments: [{
      ...transcriptA.segments[0],
      segment_id: "seg_000002",
      text: "Founder resilience"
    }]
  };
  const configuredProject: CodesProject = {
    ...projectWithEvidence,
    transcripts: [transcriptA, transcriptB],
    evidence_items: [],
    ai_settings: {
      ...projectWithEvidence.ai_settings,
      provider_id: "lmstudio",
      model_id: "local-model"
    }
  };
  const runId = "run_evidence_1";
  const suggestions = [
    {
      suggestion_id: "suggestion_evidence_a",
      run_id: runId,
      kind: "evidence" as const,
      transcript_id: "T000001",
      segment_ids: ["seg_000001"],
      segment_ranges: { seg_000001: { start_offset: 0, end_offset: 19, excerpt: "Founder uncertainty" } },
      selected_text: "Founder uncertainty",
      speaker: "SPEAKER_00",
      start: 0,
      end: 4,
      rationale: "Relevant to uncertainty."
    },
    {
      suggestion_id: "suggestion_evidence_b",
      run_id: runId,
      kind: "evidence" as const,
      transcript_id: "T000002",
      segment_ids: ["seg_000002"],
      segment_ranges: { seg_000002: { start_offset: 0, end_offset: 18, excerpt: "Founder resilience" } },
      selected_text: "Founder resilience",
      speaker: "SPEAKER_00",
      start: 0,
      end: 4,
      rationale: "Relevant to resilience."
    }
  ];
  apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
  apiMocks.startAiRun.mockImplementation(async (payload) => ({
    project: payload.project,
    handle: payload.handle,
    run: makeAiRun({ run_id: runId, task: "evidence" })
  }));
  apiMocks.fetchAiRun.mockResolvedValue(makeAiRun({
    run_id: runId,
    task: "evidence",
    status: "completed",
    phase: "completed",
    progress_kind: "determinate",
    progress_label: "Completed",
    message: "Completed",
    progress_completed: 1,
    progress_total: 1,
    results: suggestions,
    finished_at: "2026-07-18T12:00:01Z"
  }));
  return configuredProject;
}

async function runEvidenceSuggestionAnalysis() {
  fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Evidence" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Evidence/ })).getByRole("button", { name: "Run" }));
  return screen.findByText("Evidence Suggestions (2)", {}, { timeout: 2500 });
}

async function runCodeSuggestionAnalysis() {
  fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
  fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));
  return screen.findByLabelText("AI Code Suggestions", {}, { timeout: 2500 });
}

async function openCodebookCodeEditor() {
  fireEvent.click(screen.getByRole("tab", { name: "Codebook" }));
  const codeRow = await screen.findByRole("button", { name: /Uncertainty/ });
  fireEvent.click(codeRow);
  const codeName = screen.getByLabelText("Code Name");
  fireEvent.change(codeName, { target: { value: "Uncertainty revised" } });
  return codeName;
}

async function openCodebookThemeEditor() {
  fireEvent.click(screen.getByRole("tab", { name: "Codebook" }));
  fireEvent.click(screen.getByRole("tab", { name: /Themes/ }));
  const themeRow = await screen.findByRole("button", { name: /Interview Setup/ });
  fireEvent.click(themeRow);
  const themeName = screen.getByLabelText("Theme Name");
  fireEvent.change(themeName, { target: { value: "Interview Setup revised" } });
  return themeName;
}

describe("CodesPage workflow", () => {
  beforeEach(() => {
    apiMocks.pickProject.mockReset().mockResolvedValue(handle.project_file);
    apiMocks.pickProjectSaveFile.mockReset().mockResolvedValue(null);
    apiMocks.loadProject.mockReset().mockResolvedValue({ ...handle, project, handle });
    apiMocks.saveProject.mockReset().mockImplementation(async (_file, savedProject, savedHandle) => ({
      project: savedProject,
      handle: { ...savedHandle, revision: "b".repeat(64) }
    }));
    apiMocks.updateCode.mockReset();
    apiMocks.updateTheme.mockReset();
    apiMocks.updateEvidence.mockReset().mockImplementation(async (payload) => makeUpdatedEvidencePayload(payload));
    apiMocks.deleteEvidence.mockReset();
    apiMocks.recordAiDecision.mockReset().mockImplementation(async (payload) => makeAiDecisionPayload({
      sourceProject: payload.project,
      sourceHandle: payload.handle,
      suggestionId: payload.suggestion_id,
      task: payload.task
    }));
    apiMocks.fetchProviders.mockReset().mockResolvedValue({ providers: [] });
    apiMocks.fetchModels.mockReset().mockImplementation(async (providerId: string) => ({
      provider_id: providerId,
      provider_name: providerId === "lmstudio" ? "LM Studio" : "Ollama",
      models: []
    }));
    apiMocks.refreshProviders.mockReset().mockResolvedValue(undefined);
    apiMocks.startAiRun.mockReset();
    apiMocks.fetchAiRun.mockReset();
    apiMocks.cancelAiRun.mockReset();
    apiMocks.removeTranscript.mockReset();
    apiMocks.pickTranscriptFile.mockReset().mockResolvedValue(null);
    apiMocks.pickTranscriptFolder.mockReset().mockResolvedValue(null);
    apiMocks.previewTranscriptImport.mockReset();
    apiMocks.importTranscriptCandidates.mockReset();
    apiMocks.pickExportBundleFile.mockReset().mockResolvedValue(null);
    apiMocks.exportProjectBundle.mockReset();
    apiMocks.openPath.mockReset().mockResolvedValue(undefined);
  });

  it("opens a coding project into the stabilized workspace without loading AI providers", async () => {
    renderPage();

    expect(screen.queryByText("No Coding Project Open")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create New Project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));

    expect(await screen.findByText("Founder Interviews")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transcript Coding" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(apiMocks.fetchProviders).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    expect(screen.getByRole("button", { name: "Create New Project" })).toBeInTheDocument();
    expect(screen.queryByText("Founder Interviews")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"dirty":false'));
  });

  it("saves pending project edits to the active project file", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Revised Study" } });
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"dirty":true'));
    fireEvent.click(saveButton);

    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveProject).toHaveBeenCalledWith(
      handle.project_file,
      expect.objectContaining({ name: "Revised Study" }),
      handle
    );
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"dirty":false'));
  });

  it("uses the provided provider snapshot without independently discovering providers", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    expect(apiMocks.fetchProviders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("AI Assistant Settings"));

    expect(screen.getByLabelText("Provider")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "LM Studio" })).toBeInTheDocument();
    expect(apiMocks.fetchProviders).not.toHaveBeenCalled();
  });

  it("opens and closes AI settings and project prompt templates", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    const aiSettingsButton = screen.getByRole("button", { name: "AI Assistant Settings" });
    const aiSettingsContent = document.getElementById("codes-ai-settings-content");
    expect(aiSettingsButton).toHaveAttribute("aria-expanded", "false");
    expect(aiSettingsContent).toHaveAttribute("hidden");

    fireEvent.click(aiSettingsButton);
    expect(aiSettingsButton).toHaveAttribute("aria-expanded", "true");
    expect(aiSettingsContent).not.toHaveAttribute("hidden");

    const promptTemplatesButton = screen.getByRole("button", { name: "Project Prompt Templates" });
    const promptTemplatesContent = document.getElementById("codes-ai-prompt-list");
    expect(promptTemplatesButton).toHaveAttribute("aria-expanded", "false");
    expect(promptTemplatesContent).toHaveAttribute("hidden");

    fireEvent.click(promptTemplatesButton);
    expect(promptTemplatesButton).toHaveAttribute("aria-expanded", "true");
    expect(promptTemplatesContent).not.toHaveAttribute("hidden");

    fireEvent.click(promptTemplatesButton);
    expect(promptTemplatesButton).toHaveAttribute("aria-expanded", "false");
    expect(promptTemplatesContent).toHaveAttribute("hidden");

    fireEvent.click(aiSettingsButton);
    expect(aiSettingsButton).toHaveAttribute("aria-expanded", "false");
    expect(aiSettingsContent).toHaveAttribute("hidden");
  });

  it("refreshes the shared provider snapshot and keeps trustworthy providers visible after an error", async () => {
    renderPage({ providerError: "Provider refresh failed." });
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));

    expect(screen.getByRole("option", { name: "LM Studio" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Provider status: Provider refresh failed.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Providers" }));

    await waitFor(() => expect(apiMocks.refreshProviders).toHaveBeenCalledTimes(1));
    expect(apiMocks.fetchProviders).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "LM Studio" })).toBeInTheDocument();
  });

  it("retains a stored model, clears it only on an explicit provider change, and persists the replacement", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockImplementation(async (providerId: string) => ({
      provider_id: providerId,
      provider_name: providerId === "lmstudio" ? "LM Studio" : "Ollama",
      models: [{
        id: providerId === "lmstudio" ? "local-model" : "ollama-model",
        display_name: providerId === "lmstudio" ? "Local Model" : "Ollama Model",
        details: "",
        context_length: null,
        is_loaded: false
      }]
    }));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("local-model"));

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Local Model" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "Ollama Model" })).toBeInTheDocument());
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledWith(
      handle.project_file,
      expect.objectContaining({ ai_settings: expect.objectContaining({ provider_id: "ollama", model_id: "" }) }),
      expect.anything()
    ));

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ollama-model" } });
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenLastCalledWith(
      handle.project_file,
      expect.objectContaining({ ai_settings: expect.objectContaining({ provider_id: "ollama", model_id: "ollama-model" }) }),
      expect.anything()
    ));
  });

  it("shows a missing stored model as unavailable and blocks AI start", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "missing-model"
      }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "other-model", display_name: "Other Model", details: "", context_length: null, is_loaded: false }]
    });

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    expect(await screen.findByRole("option", { name: "Unavailable: missing-model" })).toBeInTheDocument();
    expect(screen.getByText(/missing-model is not available from LM Studio/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Suggest Codes/ })).not.toBeInTheDocument();
  });

  it("shows an unavailable configured provider and blocks AI start", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    renderPage({
      providers: [{ ...availableProviders[0], running: false, available: false, message: "Start LM Studio." }]
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));

    expect(await screen.findByText(/LM Studio is not currently available/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unavailable: LM Studio" })).toBeInTheDocument();
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    expect(apiMocks.fetchModels).not.toHaveBeenCalled();
  });

  it("presents provider and model catalog errors independently from AI task errors", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockRejectedValue(new Error("Model list failed."));

    renderPage({ providerError: "Provider status failed." });
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));

    expect(await screen.findByText("Provider status: Provider status failed.")).toBeInTheDocument();
    expect(await screen.findByText("Model catalog: Model list failed.")).toBeInTheDocument();
    expect(screen.queryByText("Choose a local AI provider and model before running assistance.")).not.toBeInTheDocument();
  });

  it("stages saved-evidence changes until Save and restores them on Cancel", async () => {
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    const inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    const note = within(inspector!).getByLabelText("Note");
    fireEvent.change(note, { target: { value: "Temporary note" } });
    expect(apiMocks.updateEvidence).not.toHaveBeenCalled();
    fireEvent.click(within(inspector!).getByRole("button", { name: "Cancel" }));
    expect(note).toHaveValue("");

    fireEvent.change(note, { target: { value: "Saved note" } });
    fireEvent.click(within(inspector!).getByRole("button", { name: "Remove Uncertainty from evidence" }));
    expect(apiMocks.updateEvidence).not.toHaveBeenCalled();
    fireEvent.click(within(inspector!).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.updateEvidence).toHaveBeenCalledTimes(1));
    expect(apiMocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidence_id: "E000001",
      memo: "Saved note",
      code_ids: [],
      new_codes: []
    }));
  });

  it("guards transcript, workspace, codebook-view, and project navigation with every draft-dialog outcome", async () => {
    const multiTranscriptProject = {
      ...projectWithTheme,
      transcripts: [...projectWithTheme.transcripts, importedTranscript]
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: multiTranscriptProject, handle });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    let inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector!).getByLabelText("Note"), { target: { value: "Keep this draft" } });

    const navigator = screen.getByRole("region", { name: "Transcript Navigator" });
    const transcriptSelect = within(navigator).getByRole("combobox");
    fireEvent.change(transcriptSelect, { target: { value: "T000002" } });
    let draftDialog = screen.getByRole("alertdialog", { name: "Unsaved Draft" });
    const projectPickerCalls = apiMocks.pickProject.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(apiMocks.pickProject).toHaveBeenCalledTimes(projectPickerCalls);
    expect(screen.getByRole("alertdialog", { name: "Unsaved Draft" })).toBeInTheDocument();
    fireEvent.click(within(draftDialog).getByRole("button", { name: "Cancel" }));
    expect(transcriptSelect).toHaveValue("T000001");

    fireEvent.change(transcriptSelect, { target: { value: "T000002" } });
    draftDialog = screen.getByRole("alertdialog", { name: "Unsaved Draft" });
    fireEvent.click(within(draftDialog).getByRole("button", { name: "Discard Draft" }));
    await waitFor(() => expect(transcriptSelect).toHaveValue("T000002"));

    fireEvent.change(transcriptSelect, { target: { value: "T000001" } });
    await waitFor(() => expect(transcriptSelect).toHaveValue("T000001"));
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector!).getByLabelText("Note"), { target: { value: "Save before leaving" } });

    fireEvent.click(screen.getByRole("tab", { name: "Codebook" }));
    draftDialog = screen.getByRole("alertdialog", { name: "Unsaved Draft" });
    fireEvent.click(within(draftDialog).getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(apiMocks.updateEvidence).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Codebook" })).toHaveAttribute("aria-selected", "true"));

    const codeRow = await screen.findByRole("button", { name: /Uncertainty/ });
    fireEvent.click(codeRow);
    fireEvent.change(screen.getByLabelText("Code Name"), { target: { value: "Uncertainty revised" } });
    fireEvent.click(screen.getByRole("tab", { name: /Themes/ }));
    draftDialog = screen.getByRole("alertdialog", { name: "Unsaved Draft" });
    fireEvent.click(within(draftDialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: /Codes/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    draftDialog = screen.getByRole("alertdialog", { name: "Unsaved Draft" });
    fireEvent.click(within(draftDialog).getByRole("button", { name: "Discard Draft" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(2));
  });

  it("uses an accessible evidence-deletion dialog and discards unsaved inspector changes only after confirmation", async () => {
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    const deletedProject = { ...projectWithEvidence, evidence_items: [] };
    const deletedHandle = { ...handle, revision: "c".repeat(64) };
    apiMocks.deleteEvidence.mockResolvedValueOnce({
      ...deletedHandle,
      project: deletedProject,
      handle: deletedHandle,
      evidence_id: "E000001"
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    const inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector!).getByLabelText("Note"), { target: { value: "Unsaved note" } });
    fireEvent.click(within(inspector!).getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete Evidence" });
    expect(within(dialog).getByText(/E000001/)).toBeInTheDocument();
    expect(within(dialog).getByText(/unsaved inspector changes/i)).toBeInTheDocument();
    expect(apiMocks.deleteEvidence).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(apiMocks.deleteEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: projectWithEvidence.project_id }),
      expect.objectContaining({ revision: handle.revision }),
      "E000001"
    ));
    expect(screen.queryByRole("alertdialog", { name: "Delete Evidence" })).not.toBeInTheDocument();
    expect(screen.getAllByText((_content, element) => element?.textContent === "0 Evidence Items")).not.toHaveLength(0);
  });

  it("keeps contextual suggestions through unrelated renders and clears them for a new inspector target", async () => {
    const secondEvidence = {
      ...projectWithEvidence.evidence_items[0],
      evidence_id: "E000002",
      selected_text: "A second passage",
      segment_ranges: { seg_000001: { start_offset: 0, end_offset: 8, excerpt: "A second" } },
      code_ids: []
    };
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      },
      evidence_items: [...projectWithEvidence.evidence_items, secondEvidence]
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.startAiRun.mockImplementation(async (payload) => ({
      project: payload.project,
      handle: payload.handle,
      run: makeAiRun()
    }));
    apiMocks.fetchAiRun.mockResolvedValue(makeAiRun({
      status: "completed",
      phase: "completed",
      progress_kind: "determinate",
      progress_label: "Completed",
      message: "Completed",
      progress_completed: 1,
      progress_total: 1,
      results: [{
        suggestion_id: "suggestion_codes_1",
        kind: "existing_code",
        code_id: "C000001",
        name: "Suggested Fit",
        description: "",
        rationale: "Matches the current definition."
      }],
      finished_at: "2026-07-18T12:00:01Z"
    }));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Suggested Fit", {}, { timeout: 2500 })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Evidence Scope"), { target: { value: "all" } });
    expect(screen.getByText("Suggested Fit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /A second passage/ }));
    await waitFor(() => expect(screen.queryByText("Suggested Fit")).not.toBeInTheDocument());
  });

  it("removes a rejected evidence suggestion only after persistence and navigates to the authoritative next transcript", async () => {
    const configuredProject = prepareCompletedEvidenceSuggestionRun();
    const pendingDecision = deferred<CodesAiDecisionPayload>();
    apiMocks.recordAiDecision.mockReturnValueOnce(pendingDecision.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestionsHeading = await runEvidenceSuggestionAnalysis();
    const suggestions = suggestionsHeading.closest("details");
    expect(suggestions).not.toBeNull();
    const firstSuggestion = within(suggestions!).getByText("Founder uncertainty").closest("article");
    expect(firstSuggestion).not.toBeNull();
    expect(firstSuggestion).toHaveClass("active");
    const navigator = screen.getByRole("region", { name: "Transcript Navigator" });
    const transcriptSelect = within(navigator).getByRole("combobox");
    expect(transcriptSelect).toHaveValue("T000001");

    fireEvent.click(within(firstSuggestion!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(apiMocks.recordAiDecision).toHaveBeenCalledTimes(1));
    expect(within(suggestions!).getByText("Founder uncertainty")).toBeInTheDocument();
    expect(transcriptSelect).toHaveValue("T000001");

    const request = apiMocks.recordAiDecision.mock.calls[0][0];
    await act(async () => {
      pendingDecision.resolve(makeAiDecisionPayload({
        sourceProject: request.project,
        sourceHandle: request.handle,
        suggestionId: request.suggestion_id,
        task: request.task
      }));
      await pendingDecision.promise;
    });

    await waitFor(() => expect(within(suggestions!).queryByText("Founder uncertainty")).not.toBeInTheDocument());
    const nextSuggestion = within(suggestions!).getByText("Founder resilience").closest("article");
    expect(nextSuggestion).toHaveClass("active");
    expect(transcriptSelect).toHaveValue("T000002");
    const reader = screen.getByText("Transcript Reader").closest("section");
    expect(reader).not.toBeNull();
    expect(within(reader!).getByText("Founder resilience")).toBeInTheDocument();
    expect(within(suggestions!).getByRole("button", { name: "Dismiss" })).toBeEnabled();
    expect(configuredProject.transcripts).toHaveLength(2);
  });

  it("retains the evidence suggestion and transcript context when rejection persistence fails", async () => {
    prepareCompletedEvidenceSuggestionRun();
    apiMocks.recordAiDecision.mockRejectedValueOnce(new Error("Decision save failed."));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestionsHeading = await runEvidenceSuggestionAnalysis();
    const suggestions = suggestionsHeading.closest("details");
    expect(suggestions).not.toBeNull();
    const firstSuggestion = within(suggestions!).getByText("Founder uncertainty").closest("article");
    expect(firstSuggestion).not.toBeNull();
    fireEvent.click(within(firstSuggestion!).getByRole("button", { name: "Dismiss" }));

    expect(await within(firstSuggestion!).findByRole("alert")).toHaveTextContent("Decision save failed.");
    expect(within(suggestions!).getByText("Founder uncertainty")).toBeInTheDocument();
    expect(within(suggestions!).getByText("Founder resilience")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Transcript Navigator" })).getByRole("combobox")).toHaveValue("T000001");
  });

  it("retains an AI code suggestion when its assignment does not change the current evidence draft", async () => {
    prepareCompletedCodeSuggestionRun();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    const suggestion = within(suggestions).getByText("Suggested Fit").closest("article");
    expect(suggestion).not.toBeNull();
    fireEvent.click(within(suggestion!).getByRole("button", { name: "Add" }));
    expect(within(suggestions).getByText("Suggested Fit")).toBeInTheDocument();
    expect(apiMocks.updateEvidence).not.toHaveBeenCalled();
  });

  it("removes an AI code suggestion only after it stages a new local assignment", async () => {
    const additionalCode = {
      ...projectWithEvidence.codes[0],
      code_id: "C000002",
      name: "Follow-up"
    };
    const configuredProject = {
      ...projectWithEvidence,
      codes: [...projectWithEvidence.codes, additionalCode],
      ai_settings: { ...projectWithEvidence.ai_settings, provider_id: "lmstudio", model_id: "local-model" }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.startAiRun.mockImplementation(async (payload) => ({ project: payload.project, handle: payload.handle, run: makeAiRun() }));
    apiMocks.fetchAiRun.mockResolvedValue(makeAiRun({
      status: "completed",
      phase: "completed",
      progress_kind: "determinate",
      progress_label: "Completed",
      message: "Completed",
      progress_completed: 1,
      progress_total: 1,
      results: [{
        suggestion_id: "suggestion_codes_2",
        kind: "existing_code",
        code_id: "C000002",
        name: "Follow-up",
        description: "",
        rationale: "Complements the current assignment."
      }],
      finished_at: "2026-07-18T12:00:01Z"
    }));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    const suggestion = within(suggestions).getByText("Follow-up").closest("article");
    expect(suggestion).not.toBeNull();
    fireEvent.click(within(suggestion!).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(suggestions).queryByText("Follow-up")).not.toBeInTheDocument());
    expect(apiMocks.updateEvidence).not.toHaveBeenCalled();
  });

  it("locks conflicting workflows and retains a contextual suggestion until its rejection is persisted", async () => {
    prepareCompletedCodeSuggestionRun();
    const pendingDecision = deferred<CodesAiDecisionPayload>();
    apiMocks.recordAiDecision.mockReturnValueOnce(pendingDecision.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    const suggestion = within(suggestions).getByText("Suggested Fit").closest("article");
    expect(suggestion).not.toBeNull();
    fireEvent.click(within(suggestion!).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(apiMocks.recordAiDecision).toHaveBeenCalledTimes(1));
    expect(within(suggestion!).getByText("Suggested Fit")).toBeInTheDocument();
    expect(within(suggestion!).getByRole("button", { name: "Dismissing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Transcript" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Add Transcripts"));
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getAllByRole("button")
      .filter((element) => element.getAttribute("aria-label")?.startsWith("AI:"))
      .every((element) => element.hasAttribute("disabled"))).toBe(true);
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":true'));
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent("Saving a Codes AI decision");

    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    expect(screen.getByRole("button", { name: "Creating Bundle…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Transcript Coding" }));

    const request = apiMocks.recordAiDecision.mock.calls[0][0];
    await act(async () => {
      pendingDecision.resolve(makeAiDecisionPayload({
        sourceProject: request.project,
        sourceHandle: request.handle,
        suggestionId: request.suggestion_id,
        task: request.task
      }));
      await pendingDecision.promise;
    });

    await waitFor(() => expect(screen.queryByText("Suggested Fit")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":false'));
  });

  it("keeps decision failures local to their suggestion and clears them when the project is replaced", async () => {
    const configuredProject = prepareCompletedCodeSuggestionRun();
    const replacementHandle = {
      ...handle,
      project_file: "D:\\research\\replacement.evidence.json",
      revision: "d".repeat(64)
    };
    apiMocks.pickProject
      .mockResolvedValueOnce(handle.project_file)
      .mockResolvedValueOnce(replacementHandle.project_file);
    apiMocks.loadProject
      .mockResolvedValueOnce({ ...handle, project: configuredProject, handle })
      .mockResolvedValueOnce({
        ...replacementHandle,
        project: configuredProject,
        handle: replacementHandle
      });
    apiMocks.recordAiDecision.mockRejectedValueOnce(new Error("Decision save failed."));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    const suggestion = within(suggestions).getByText("Suggested Fit").closest("article");
    expect(suggestion).not.toBeNull();
    fireEvent.click(within(suggestion!).getByRole("button", { name: "Dismiss" }));

    const decisionError = await within(suggestions).findByRole("alert");
    expect(decisionError).toHaveTextContent("Decision save failed.");
    expect(within(suggestions).getByText("Suggested Fit")).toBeInTheDocument();
    expect(within(suggestions).getByRole("button", { name: "Retry" })).toBeEnabled();
    const reader = screen.getByText("Transcript Reader").closest("section");
    expect(reader).not.toBeNull();
    expect(within(reader!).queryByText("Decision save failed.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Decision save failed.")).not.toBeInTheDocument();
    expect(screen.queryByText("Suggested Fit")).not.toBeInTheDocument();
  });

  it("blocks evidence decisions while import and export pickers own the project", async () => {
    prepareCompletedCodeSuggestionRun();
    const importPicker = deferred<string | null>();
    const exportPicker = deferred<string | null>();
    apiMocks.pickTranscriptFile.mockReturnValueOnce(importPicker.promise);
    apiMocks.pickExportBundleFile.mockReturnValueOnce(exportPicker.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    let suggestions = await runCodeSuggestionAnalysis();

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    await waitFor(() => expect(apiMocks.pickTranscriptFile).toHaveBeenCalledTimes(1));
    expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    expect(apiMocks.recordAiDecision).not.toHaveBeenCalled();
    await act(async () => {
      importPicker.resolve(null);
      await importPicker.promise;
    });
    await waitFor(() => expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeEnabled());

    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Bundle…" }));
    await waitFor(() => expect(apiMocks.pickExportBundleFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Transcript Coding" }));
    suggestions = screen.getByLabelText("AI Code Suggestions");
    expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    expect(apiMocks.recordAiDecision).not.toHaveBeenCalled();
    await act(async () => {
      exportPicker.resolve(null);
      await exportPicker.promise;
    });
    await waitFor(() => expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeEnabled());
  });

  it("blocks evidence decisions during ordinary mutations and settings persistence", async () => {
    prepareCompletedCodeSuggestionRun();
    const pendingEvidence = deferred<CodesEvidencePayload>();
    apiMocks.updateEvidence.mockReturnValueOnce(pendingEvidence.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    const refreshProviders = screen.getByRole("button", { name: "Refresh Providers" });
    const suggestions = await runCodeSuggestionAnalysis();
    const inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector!).getByLabelText("Note"), { target: { value: "Pending note" } });
    act(() => {
      fireEvent.click(within(inspector!).getByRole("button", { name: "Save" }));
      fireEvent.click(refreshProviders);
    });
    await waitFor(() => expect(apiMocks.updateEvidence).toHaveBeenCalledTimes(1));
    expect(apiMocks.refreshProviders).not.toHaveBeenCalled();
    expect(within(inspector!).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(inspector!).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Transcript" })).toBeDisabled();
    expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    expect(apiMocks.recordAiDecision).not.toHaveBeenCalled();
    const evidenceRequest = apiMocks.updateEvidence.mock.calls[0][0];
    await act(async () => {
      pendingEvidence.resolve(makeUpdatedEvidencePayload(evidenceRequest));
      await pendingEvidence.promise;
    });
    await waitFor(() => expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeEnabled());

    const pendingSettings = deferred<{ project: CodesProject; handle: CodesProjectHandle }>();
    apiMocks.saveProject.mockReturnValueOnce(pendingSettings.promise);
    fireEvent.click(screen.getByText("Project Settings"));
    const projectName = screen.getByLabelText("Project Name");
    fireEvent.change(projectName, { target: { value: "Pending Settings" } });
    fireEvent.blur(projectName);
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledTimes(1));
    expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    expect(apiMocks.recordAiDecision).not.toHaveBeenCalled();
    const [, savedProject, savedHandle] = apiMocks.saveProject.mock.calls[0];
    await act(async () => {
      pendingSettings.resolve({
        project: savedProject,
        handle: { ...savedHandle, revision: "d".repeat(64) }
      });
      await pendingSettings.promise;
    });
    await waitFor(() => expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeEnabled());
  });

  it("blocks evidence decisions while another contextual AI run is active", async () => {
    prepareCompletedCodeSuggestionRun();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    const pendingStart = deferred<{ project: CodesProject; handle: CodesProjectHandle; run: CodesAiRunSnapshot }>();
    apiMocks.startAiRun.mockReturnValueOnce(pendingStart.promise);

    fireEvent.click(screen.getByRole("button", { name: "AI: Draft Note" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Draft Note/ })).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(apiMocks.startAiRun).toHaveBeenCalledTimes(2));
    expect(within(suggestions).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    expect(apiMocks.recordAiDecision).not.toHaveBeenCalled();
    const request = apiMocks.startAiRun.mock.calls[1][0];
    await act(async () => {
      pendingStart.resolve({
        project: request.project,
        handle: request.handle,
        run: makeAiRun({
          task: "note",
          status: "cancelled",
          phase: "cancelled",
          progress_label: "Cancelled",
          message: "Cancelled",
          finished_at: "2026-07-18T12:00:01Z"
        })
      });
      await pendingStart.promise;
    });
  });

  it("blocks other project workflows while a Codebook save is active", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: { ...projectWithEvidence.ai_settings, provider_id: "lmstudio", model_id: "local-model" }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    const pendingCodeSave = deferred<unknown>();
    apiMocks.updateCode.mockReturnValueOnce(pendingCodeSave.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    await openCodebookCodeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save Code" }));
    await waitFor(() => expect(apiMocks.updateCode).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: "New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI: Refine Code" })).toBeDisabled();
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    expect(apiMocks.saveProject).not.toHaveBeenCalled();
    expect(apiMocks.updateEvidence).not.toHaveBeenCalled();

    const updatedCode = { ...configuredProject.codes[0], name: "Uncertainty revised" };
    const nextHandle = { ...handle, revision: "f".repeat(64) };
    await act(async () => {
      pendingCodeSave.resolve({
        project: { ...configuredProject, codes: [updatedCode] },
        handle: nextHandle,
        code: updatedCode,
        project_id: configuredProject.project_id,
        project_file: nextHandle.project_file,
        revision: nextHandle.revision
      });
      await pendingCodeSave.promise;
    });
  });

  it("blocks a Codebook save while contextual AI analysis is active", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: { ...projectWithEvidence.ai_settings, provider_id: "lmstudio", model_id: "local-model" }
    };
    const pendingStart = deferred<{ project: CodesProject; handle: CodesProjectHandle; run: CodesAiRunSnapshot }>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: null, is_loaded: true }]
    });
    apiMocks.startAiRun.mockReturnValue(pendingStart.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("local-model"));
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(apiMocks.startAiRun).toHaveBeenCalledTimes(1));

    await openCodebookCodeEditor();
    expect(screen.getByRole("button", { name: "Save Code" })).toBeDisabled();
    expect(apiMocks.updateCode).not.toHaveBeenCalled();

    await act(async () => {
      pendingStart.resolve({ project: configuredProject, handle, run: makeAiRun({ status: "cancelled", phase: "cancelled", progress_label: "Cancelled" }) });
      await pendingStart.promise;
    });
  });

  it("visibly blocks Theme saves while contextual AI analysis is active", async () => {
    const configuredProject = {
      ...projectWithTheme,
      ai_settings: { ...projectWithTheme.ai_settings, provider_id: "lmstudio", model_id: "local-model" }
    };
    const pendingStart = deferred<{ project: CodesProject; handle: CodesProjectHandle; run: CodesAiRunSnapshot }>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: null, is_loaded: true }]
    });
    apiMocks.startAiRun.mockReturnValue(pendingStart.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("local-model"));
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(apiMocks.startAiRun).toHaveBeenCalledTimes(1));

    await openCodebookThemeEditor();
    expect(screen.getByRole("button", { name: "Save Theme" })).toBeDisabled();
    expect(apiMocks.updateTheme).not.toHaveBeenCalled();

    await act(async () => {
      pendingStart.resolve({ project: configuredProject, handle, run: makeAiRun({ status: "cancelled", phase: "cancelled", progress_label: "Cancelled" }) });
      await pendingStart.promise;
    });
  });

  it("blocks a Codebook save while an AI decision is being persisted", async () => {
    prepareCompletedCodeSuggestionRun();
    const pendingDecision = deferred<CodesAiDecisionPayload>();
    apiMocks.recordAiDecision.mockReturnValueOnce(pendingDecision.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(apiMocks.recordAiDecision).toHaveBeenCalledTimes(1));

    await openCodebookCodeEditor();
    expect(screen.getByRole("button", { name: "Save Code" })).toBeDisabled();
    expect(apiMocks.updateCode).not.toHaveBeenCalled();

    const request = apiMocks.recordAiDecision.mock.calls[0][0];
    await act(async () => {
      pendingDecision.resolve(makeAiDecisionPayload({ sourceProject: request.project, sourceHandle: request.handle, suggestionId: request.suggestion_id, task: request.task }));
      await pendingDecision.promise;
    });
  });

  it("blocks a Codebook save while transcript import owns the project", async () => {
    const pendingPicker = deferred<string | null>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    apiMocks.pickTranscriptFile.mockReturnValue(pendingPicker.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled());

    await openCodebookCodeEditor();
    expect(screen.getByRole("button", { name: "Save Code" })).toBeDisabled();
    expect(apiMocks.updateCode).not.toHaveBeenCalled();

    await act(async () => {
      pendingPicker.resolve(null);
      await pendingPicker.promise;
    });
  });

  it("blocks a Codebook save while export owns the project", async () => {
    const pendingPicker = deferred<string | null>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    apiMocks.pickExportBundleFile.mockReturnValue(pendingPicker.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Bundle…" }));
    await waitFor(() => expect(apiMocks.pickExportBundleFile).toHaveBeenCalledTimes(1));

    await openCodebookCodeEditor();
    expect(screen.getByRole("button", { name: "Save Code" })).toBeDisabled();
    expect(apiMocks.updateCode).not.toHaveBeenCalled();

    await act(async () => {
      pendingPicker.resolve(null);
      await pendingPicker.promise;
    });
  });

  it("blocks a Codebook save while project settings persistence is active", async () => {
    const pendingSave = deferred<{ project: CodesProject; handle: CodesProjectHandle }>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    apiMocks.saveProject.mockReturnValue(pendingSave.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("Project Settings"));
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Renamed Project" } });
    fireEvent.blur(screen.getByLabelText("Project Name"));
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledTimes(1));

    await openCodebookCodeEditor();
    expect(screen.getByRole("button", { name: "Save Code" })).toBeDisabled();
    expect(apiMocks.updateCode).not.toHaveBeenCalled();

    await act(async () => {
      pendingSave.resolve({ project, handle: { ...handle, revision: "b".repeat(64) } });
      await pendingSave.promise;
    });
  });

  it("keeps an AI code refinement local until the normal Codebook save", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: { ...projectWithEvidence.ai_settings, provider_id: "lmstudio", model_id: "local-model" }
    };
    const refinedCode = {
      suggestion_id: "suggestion_refine_1",
      run_id: "run_refine_1",
      kind: "code_refinement" as const,
      code_id: configuredProject.codes[0].code_id,
      name: "Refined Uncertainty",
      description: "A refined definition.",
      inclusion_note: "Include uncertainty statements.",
      exclusion_note: "Exclude unrelated statements.",
      memo: "Refined note.",
      rationale: "The evidence supports a narrower definition."
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: null, is_loaded: true }]
    });
    apiMocks.startAiRun.mockImplementation(async (payload) => ({ project: payload.project, handle: payload.handle, run: makeAiRun({ task: "code_refinement", run_id: refinedCode.run_id }) }));
    apiMocks.fetchAiRun.mockResolvedValue(makeAiRun({ task: "code_refinement", run_id: refinedCode.run_id, status: "completed", phase: "completed", progress_kind: "determinate", progress_label: "Completed", results: [refinedCode] }));
    apiMocks.updateCode.mockResolvedValue({
      project: { ...configuredProject, codes: [{ ...configuredProject.codes[0], name: refinedCode.name }] },
      handle: { ...handle, revision: "f".repeat(64) },
      code: { ...configuredProject.codes[0], name: refinedCode.name },
      project_id: configuredProject.project_id,
      project_file: handle.project_file,
      revision: "f".repeat(64)
    });

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    await openCodebookCodeEditor();
    fireEvent.click(screen.getByRole("button", { name: "AI: Refine Code" }));
    await screen.findByLabelText("AI Code Refinement");
    fireEvent.click(screen.getByRole("button", { name: "Apply All" }));
    expect(screen.getByLabelText("Code Name")).toHaveValue("Refined Uncertainty");
    expect(apiMocks.updateCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Code" }));
    await waitFor(() => expect(apiMocks.updateCode).toHaveBeenCalledTimes(1));
    expect(apiMocks.updateCode).toHaveBeenCalledWith(expect.objectContaining({
      ai_decisions: [expect.objectContaining({ suggestion_id: refinedCode.suggestion_id, decision: "accepted" })]
    }));
  });

  it("clears a page save error on retry and shows the authoritative success status", async () => {
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    const updatedCode = { ...projectWithEvidence.codes[0], name: "Uncertainty revised" };
    const nextHandle = { ...handle, revision: "f".repeat(64) };
    apiMocks.updateCode
      .mockRejectedValueOnce(new Error("Code could not be saved."))
      .mockResolvedValueOnce({
        project: { ...projectWithEvidence, codes: [updatedCode] },
        handle: nextHandle,
        code: updatedCode,
        project_id: projectWithEvidence.project_id,
        project_file: nextHandle.project_file,
        revision: nextHandle.revision
      });

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    await openCodebookCodeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save Code" }));
    await waitFor(() => expect(apiMocks.updateCode).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("Code could not be saved.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Save Code" }));
    await waitFor(() => expect(apiMocks.updateCode).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Code could not be saved.")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Uncertainty revised/ })).toBeInTheDocument();
  });

  it("clears a code save error when the project is replaced", async () => {
    const replacementProject = {
      ...projectWithEvidence,
      project_id: "project_replacement",
      name: "Replacement Study"
    };
    const replacementHandle = {
      ...handle,
      project_id: replacementProject.project_id,
      project_file: "D:\\research\\replacement.evidence.json",
      revision: "d".repeat(64)
    };
    apiMocks.pickProject
      .mockResolvedValueOnce(handle.project_file)
      .mockResolvedValueOnce(replacementHandle.project_file);
    apiMocks.loadProject
      .mockResolvedValueOnce({ ...handle, project: projectWithEvidence, handle })
      .mockResolvedValueOnce({ ...replacementHandle, project: replacementProject, handle: replacementHandle });
    apiMocks.updateCode.mockRejectedValueOnce(new Error("Code save failed."));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    await openCodebookCodeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save Code" }));
    await waitFor(() => expect(screen.getAllByText("Code save failed.").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard Draft" }));
    await screen.findByText("Replacement Study");
    expect(screen.queryByText("Code save failed.")).not.toBeInTheDocument();
  });

  it("publishes a decision conflict through the established project workflow", async () => {
    prepareCompletedCodeSuggestionRun();
    const conflict = makeProjectConflict();
    apiMocks.recordAiDecision.mockRejectedValueOnce(conflict);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    const suggestions = await runCodeSuggestionAnalysis();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("Project changed outside the app")).toBeInTheDocument();
    expect(within(suggestions).getByText("Suggested Fit")).toBeInTheDocument();
    expect(within(suggestions).getByRole("alert")).toHaveTextContent(conflict.message);
    expect(within(suggestions).getByRole("button", { name: "Retry" })).toBeDisabled();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Retry" }));
    expect(apiMocks.recordAiDecision).toHaveBeenCalledTimes(1);
  });

  it("locks project replacement, settings, and other AI actions as soon as a run starts", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    const pendingStart = deferred<{
      project: CodesProject;
      handle: CodesProjectHandle;
      run: CodesAiRunSnapshot;
    }>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchProviders.mockResolvedValue({
      providers: [{ id: "lmstudio", name: "LM Studio", available: true, base_url: "http://127.0.0.1:1234" }]
    });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: null, is_loaded: false }]
    });
    apiMocks.startAiRun.mockReturnValue(pendingStart.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    await screen.findByLabelText("Provider");
    fireEvent.click(screen.getByText("Project Prompt Templates"));
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(apiMocks.startAiRun).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled();
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();
    const aiSettings = screen.getByText("AI Assistant Settings").closest("section.codes-ai-settings");
    expect(aiSettings).not.toBeNull();
    expect(within(aiSettings!).getAllByRole("spinbutton").every((element) => element.hasAttribute("disabled"))).toBe(true);
    const promptSettings = screen.getByText("Project Prompt Templates").closest("section.codes-ai-prompt-settings");
    expect(promptSettings).not.toBeNull();
    expect(within(promptSettings!).getAllByRole("textbox").every((element) => element.hasAttribute("disabled"))).toBe(true);
    expect(
      within(promptSettings!).getAllByRole("button", { name: /Save as Project Default|Restore Built-in Default/ })
        .every((element) => element.hasAttribute("disabled"))
    ).toBe(true);
    expect(screen.getAllByRole("button").filter((element) => element.getAttribute("aria-label")?.startsWith("AI:")).every((element) => element.hasAttribute("disabled"))).toBe(true);
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":true'));
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent("Codes AI assistance in progress");

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(apiMocks.loadProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingStart.resolve({
        project: configuredProject,
        handle,
        run: makeAiRun({
          status: "cancelled",
          phase: "cancelled",
          progress_label: "Cancelled",
          message: "Cancelled",
          finished_at: "2026-07-18T12:00:01Z"
        })
      });
      await pendingStart.promise;
    });
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":false'));
  });

  it("persists the latest project settings before starting contextual AI", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    const pendingSave = deferred<{ project: CodesProject; handle: CodesProjectHandle }>();
    const newerHandle = { ...handle, revision: "d".repeat(64) };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.saveProject.mockReturnValue(pendingSave.promise);
    apiMocks.startAiRun.mockImplementation(async (payload) => ({
      project: payload.project,
      handle: payload.handle,
      run: makeAiRun({
        status: "cancelled",
        phase: "cancelled",
        progress_label: "Cancelled",
        message: "Cancelled",
        finished_at: "2026-07-18T12:00:01Z"
      })
    }));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("Project Settings"));
    const researchFocus = screen.getByLabelText("Research Focus");
    fireEvent.change(researchFocus, { target: { value: "Revised focus for this run" } });
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledTimes(1));
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    await waitFor(() => expect(researchFocus).toBeDisabled());
    expect(screen.getByRole("button", { name: "New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI: Suggest Codes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    expect(apiMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();

    const savedSnapshot = apiMocks.saveProject.mock.calls[0][1] as CodesProject;
    const persistedProject = { ...savedSnapshot, research_focus: "Revised focus for this run" };
    await act(async () => {
      pendingSave.resolve({ project: persistedProject, handle: newerHandle });
      await pendingSave.promise;
    });

    await waitFor(() => expect(apiMocks.startAiRun).toHaveBeenCalledTimes(1));
    expect(apiMocks.startAiRun).toHaveBeenCalledWith(expect.objectContaining({
      project: persistedProject,
      handle: newerHandle,
      task: "codes"
    }));
    expect(apiMocks.saveProject).toHaveBeenCalledTimes(1);
  });

  it("does not start AI when the settings preflight fails", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    const pendingSave = deferred<{ project: CodesProject; handle: CodesProjectHandle }>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.saveProject.mockReturnValue(pendingSave.promise);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("Project Settings"));
    const researchFocus = screen.getByLabelText("Research Focus");
    fireEvent.change(researchFocus, { target: { value: "Unsaved revised focus" } });
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledTimes(1));
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    await waitFor(() => expect(researchFocus).toBeDisabled());

    await act(async () => {
      pendingSave.reject(new Error("Project settings save failed."));
      await expect(pendingSave.promise).rejects.toThrow("Project settings save failed.");
    });

    expect(await screen.findByText("Project settings save failed.")).toBeInTheDocument();
    await waitFor(() => expect(researchFocus).toBeEnabled());
    expect(researchFocus).toHaveValue("Unsaved revised focus");
    expect(apiMocks.startAiRun).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "AI: Suggest Codes" })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":false'));
  });

  it("preserves an active run after cancellation fails and clears the error on retry", async () => {
    const configuredProject = {
      ...projectWithEvidence,
      ai_settings: {
        ...projectWithEvidence.ai_settings,
        provider_id: "lmstudio",
        model_id: "local-model"
      }
    };
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: configuredProject, handle });
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: null, is_loaded: true }]
    });
    apiMocks.startAiRun.mockImplementation(async (payload) => ({
      project: payload.project,
      handle: payload.handle,
      run: makeAiRun()
    }));
    apiMocks.fetchAiRun.mockReturnValue(new Promise(() => undefined));
    apiMocks.cancelAiRun
      .mockRejectedValueOnce(new Error("Cancellation could not be requested."))
      .mockResolvedValueOnce(makeAiRun({ status: "cancelling", progress_label: "Cancelling…", message: "Cancelling…" }));

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByText("AI Assistant Settings"));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("local-model"));
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /Suggest Codes/ })).getByRole("button", { name: "Run" }));

    const progress = (await screen.findByText("Waiting for local model")).closest(".codes-ai-progress");
    expect(progress).not.toBeNull();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();
    fireEvent.click(within(progress!).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancellation could not be requested.")).toBeInTheDocument();
    expect(within(progress!).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();

    fireEvent.click(within(progress!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(apiMocks.cancelAiRun).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Cancellation could not be requested.")).not.toBeInTheDocument();
    expect(within(progress!).getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();
  });

  it("keeps transcript refresh hidden and protects removal when evidence exists", async () => {
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    expect(screen.queryByRole("button", { name: "Check Source for Updates…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Transcript" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove Transcript" });
    expect(within(dialog).getByText(/1 evidence item/)).toBeInTheDocument();
    expect(apiMocks.removeTranscript).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Show Evidence" }));
    expect(screen.queryByRole("alertdialog", { name: "Remove Transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Founder uncertainty/ })).toBeInTheDocument();
  });

  it("resets a pending import preview when the project closes and reopens", async () => {
    apiMocks.pickTranscriptFile.mockResolvedValue(handle.project_file);
    apiMocks.previewTranscriptImport.mockResolvedValue(importPreview);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    expect(await screen.findByText("Import Preview (1 Candidate)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    expect(screen.queryByText("Import Preview (1 Candidate)")).not.toBeInTheDocument();
  });

  it("keeps an import preview usable after Save As and imports through the new handle", async () => {
    const savedAsHandle = {
      ...handle,
      project_file: "D:\\research\\founders-copy.evidence.json",
      revision: "c".repeat(64)
    };
    const importedHandle = { ...savedAsHandle, revision: "d".repeat(64) };
    const importedProject = {
      ...project,
      transcripts: [importedTranscript]
    };
    apiMocks.pickTranscriptFile.mockResolvedValue(importCandidate.source_path);
    apiMocks.previewTranscriptImport.mockResolvedValue(importPreview);
    apiMocks.pickProjectSaveFile.mockResolvedValue(savedAsHandle.project_file);
    apiMocks.saveProject.mockResolvedValueOnce({ project, handle: savedAsHandle });
    apiMocks.importTranscriptCandidates.mockResolvedValueOnce({
      ...importedHandle,
      project: importedProject,
      handle: importedHandle,
      imported: [importedTranscript],
      skipped: [],
      failed: []
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    expect(await screen.findByText("Import Preview (1 Candidate)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledWith(
      savedAsHandle.project_file,
      project,
      handle
    ));

    expect(screen.getByText("Import Preview (1 Candidate)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));

    await waitFor(() => expect(apiMocks.importTranscriptCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        project,
        handle: savedAsHandle,
        candidates: [expect.objectContaining({ candidate_id: importCandidate.candidate_id })]
      })
    ));
    expect(await screen.findByText("1 transcript imported.")).toBeInTheDocument();
    expect(screen.getByText("Imported transcript text")).toBeInTheDocument();
  });

  it("includes picker work in the page and workbench lock", async () => {
    const pendingPicker = deferred<string | null>();
    apiMocks.pickTranscriptFile.mockReturnValue(pendingPicker.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeDisabled();
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":true');
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent("Codes operation in progress");

    await act(async () => {
      pendingPicker.resolve(null);
      await pendingPicker.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Project" })).toBeEnabled());
  });

  it("preserves the active transcript and selected evidence after a successful import", async () => {
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    apiMocks.pickTranscriptFile.mockResolvedValue(importCandidate.source_path);
    apiMocks.previewTranscriptImport.mockResolvedValue(importPreview);
    apiMocks.importTranscriptCandidates.mockResolvedValue(successfulImportPayload(projectWithEvidence));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    const inspector = screen.getByText("Evidence Inspector").closest("section");
    expect(inspector).not.toBeNull();
    expect(within(inspector!).getByText(/E000001/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    await screen.findByText("Import Preview (1 Candidate)");
    fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));

    await waitFor(() => expect(apiMocks.importTranscriptCandidates).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      within(screen.getByRole("region", { name: "Transcript Navigator" })).getByRole("combobox")
    ).toHaveValue("T000001"));
    expect(within(inspector!).getByText(/E000001/)).toBeInTheDocument();
    expect(screen.getByText("1 transcript imported.")).toBeInTheDocument();
  });

  it("selects the first imported transcript when the project had no active transcript", async () => {
    apiMocks.pickTranscriptFile.mockResolvedValue(importCandidate.source_path);
    apiMocks.previewTranscriptImport.mockResolvedValue(importPreview);
    apiMocks.importTranscriptCandidates.mockResolvedValue(successfulImportPayload(project));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");

    fireEvent.click(screen.getByRole("button", { name: "Add Transcript File" }));
    await screen.findByText("Import Preview (1 Candidate)");
    fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));

    await waitFor(() => expect(
      within(screen.getByRole("region", { name: "Transcript Navigator" })).getByRole("combobox")
    ).toHaveValue("T000002"));
    expect(screen.getByText("Imported transcript text")).toBeInTheDocument();
  });

  it("includes the export picker in project, import, and workbench locking", async () => {
    const pendingPicker = deferred<string | null>();
    apiMocks.loadProject.mockResolvedValue({ ...handle, project: projectWithEvidence, handle });
    apiMocks.pickExportBundleFile.mockReturnValue(pendingPicker.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("button", { name: /Founder uncertainty/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Bundle…" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close Project" })).toBeDisabled());
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent('"activeJob":true');
    expect(screen.getByTestId("codes-workbench-state")).toHaveTextContent("Codes operation in progress");
    fireEvent.click(screen.getByRole("tab", { name: "Transcript Coding" }));
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI: Suggest Codes" })).toBeDisabled();

    await act(async () => {
      pendingPicker.resolve(null);
      await pendingPicker.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Project" })).toBeEnabled());
  });

  it("does not inherit an export result when another project is opened", async () => {
    const replacementProject = {
      ...project,
      project_id: "project_replacement",
      name: "Replacement Study"
    };
    const replacementHandle = {
      ...handle,
      project_id: replacementProject.project_id,
      project_file: "D:\\research\\replacement.evidence.json",
      revision: "e".repeat(64)
    };
    apiMocks.pickProject
      .mockResolvedValueOnce(handle.project_file)
      .mockResolvedValueOnce(replacementHandle.project_file);
    apiMocks.loadProject
      .mockResolvedValueOnce({ ...handle, project, handle })
      .mockResolvedValueOnce({ ...replacementHandle, project: replacementProject, handle: replacementHandle });
    apiMocks.pickExportBundleFile.mockResolvedValueOnce("D:\\exports\\founders_export.zip");
    apiMocks.exportProjectBundle.mockResolvedValueOnce(exportBundlePayload);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open Existing Project" }));
    await screen.findByText("Founder Interviews");
    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Bundle…" }));
    expect(await screen.findByText("Created Export Bundle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(await screen.findByText("Replacement Study")).toBeInTheDocument();
    expect(screen.queryByText("Created Export Bundle")).not.toBeInTheDocument();
    expect(screen.queryByText(exportBundlePayload.bundle.path)).not.toBeInTheDocument();
  });
});
