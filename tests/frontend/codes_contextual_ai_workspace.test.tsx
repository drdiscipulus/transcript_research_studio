import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCodesContextualAiWorkspace } from "../../src/hooks/useCodesContextualAiWorkspace";
import {
  emptyCodeForm,
  emptyThemeForm,
  type CodeForm,
  type ThemeForm
} from "../../src/components/codes/codesPageUtils";
import type {
  CodesAiCodeSuggestion,
  CodesAiEvidenceSuggestion,
  CodesAiNoteSuggestion,
  CodesAiRunMutationPayload,
  CodesAiRunSnapshot,
  CodesAiRunStartPayload,
  CodesAiRunTask,
  CodesAiThemeSuggestion,
  CodesEvidenceItem,
  CodesProject,
  CodesProjectHandle,
  PromptingProviderStatus
} from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  start: vi.fn(),
  fetch: vi.fn(),
  cancel: vi.fn(),
  models: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    startCodesAiRun: apiMocks.start,
    fetchCodesAiRun: apiMocks.fetch,
    cancelCodesAiRun: apiMocks.cancel,
    fetchPromptingModels: apiMocks.models
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeProject(projectId = "project_a", providerId = "lmstudio", modelId = "local-model"): CodesProject {
  return {
    schema_version: "1.1",
    project_id: projectId,
    name: "Study",
    created_at: "2026-08-06T08:00:00Z",
    updated_at: "2026-08-06T08:00:00Z",
    research_focus: "How researchers interpret uncertainty",
    ai_settings: {
      provider_id: providerId,
      model_id: modelId,
      temperature: 0,
      timeout_seconds: 180,
      suggestion_language: "auto",
      prompt_overrides: { evidence: "", codes: "", note: "", codebook: "", themes: "" }
    },
    transcripts: ["T000001", "T000002", "T000003"].map((transcriptId, index) => ({
      transcript_id: transcriptId,
      label: `Interview ${index + 1}`,
      source_file: `D:\\research\\interview_${index + 1}.json`,
      source_document_id: `document_${index + 1}`,
      imported_at: "2026-08-06T08:00:00Z",
      refreshed_at: null,
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "Participant" }],
      segments: [{ segment_id: "seg_000001", start: 0, end: 1, speaker: "SPEAKER_00", text: "Evidence" }],
      metadata: {},
      validation_issues: []
    })),
    evidence_items: [selectedEvidence],
    codes: ["C000001", "C000002"].map((codeId, index) => ({
      code_id: codeId,
      name: `Code ${index + 1}`,
      description: "",
      inclusion_note: "",
      exclusion_note: "",
      example_evidence_ids: [],
      color: "#0f766e",
      memo: "",
      created_at: "2026-08-06T08:00:00Z",
      updated_at: "2026-08-06T08:00:00Z"
    })),
    themes: ["TH000001", "TH000002"].map((themeId, index) => ({
      theme_id: themeId,
      name: `Theme ${index + 1}`,
      description: "",
      color: "#164e63",
      code_ids: ["C000001"],
      memo: "",
      created_at: "2026-08-06T08:00:00Z",
      updated_at: "2026-08-06T08:00:00Z"
    })),
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
}

function makeHandle(projectId = "project_a", fileName = projectId): CodesProjectHandle {
  return {
    project_file: `D:\\research\\${fileName}.evidence.json`,
    project_id: projectId,
    revision: "a".repeat(64)
  };
}

const providers: PromptingProviderStatus[] = [{
  id: "lmstudio",
  name: "LM Studio",
  installed: true,
  running: true,
  available: true,
  requires_auth: false,
  base_url: "http://127.0.0.1:1234",
  message: "Running",
  model_count: 1
}];

function makeRun(task: CodesAiRunTask, overrides: Partial<CodesAiRunSnapshot> = {}): CodesAiRunSnapshot {
  return {
    run_id: `run_${task}`,
    project_id: "project_a",
    task,
    status: "completed",
    phase: "completed",
    progress_kind: "determinate",
    progress_label: "Completed",
    message: "Completed",
    progress_completed: 1,
    progress_total: 1,
    results: [],
    omitted: [],
    error: "",
    started_at: "2026-08-06T08:00:00Z",
    finished_at: "2026-08-06T08:00:01Z",
    ...overrides
  };
}

function startResult(payload: CodesAiRunStartPayload, run: CodesAiRunSnapshot): CodesAiRunMutationPayload {
  return { ...payload.handle, project: payload.project, handle: payload.handle, run };
}

const evidenceSuggestion: CodesAiEvidenceSuggestion = {
  suggestion_id: "suggestion_evidence",
  run_id: "run_evidence",
  kind: "evidence",
  transcript_id: "T000001",
  segment_ids: ["seg_000001"],
  segment_ranges: { seg_000001: { start_offset: 0, end_offset: 8, excerpt: "Evidence" } },
  selected_text: "Evidence",
  speaker: "SPEAKER_00",
  start: 0,
  end: 1,
  rationale: "Relevant"
};

const codeSuggestion: CodesAiCodeSuggestion = {
  suggestion_id: "suggestion_code",
  kind: "existing_code",
  code_id: "C000001",
  name: "Uncertainty",
  description: "",
  rationale: "Matches"
};

const noteSuggestion: CodesAiNoteSuggestion = {
  suggestion_id: "suggestion_note",
  kind: "note",
  note: "A concise analytical note."
};

const themeSuggestion: CodesAiThemeSuggestion = {
  suggestion_id: "suggestion_theme",
  run_id: "run_theme_suggestions",
  kind: "theme_suggestion",
  name: "Uncertainty framing",
  description: "Groups uncertainty codes.",
  memo: "",
  code_ids: ["C000001"],
  rationale: "Related codes"
};

const selectedEvidence: CodesEvidenceItem = {
  evidence_id: "E000001",
  transcript_id: "T000001",
  source_file: "transcript.json",
  source_document_id: "document_1",
  segment_ids: ["seg_000001"],
  speaker: "SPEAKER_00",
  start: 0,
  end: 1,
  selected_text: "Evidence",
  segment_ranges: { seg_000001: { start_offset: 0, end_offset: 8, excerpt: "Evidence" } },
  code_ids: [],
  memo: "",
  created_at: "2026-08-06T08:00:00Z",
  updated_at: "2026-08-06T08:00:00Z"
};

type HookProps = {
  project: CodesProject | null;
  handle: CodesProjectHandle | null;
  providerList?: PromptingProviderStatus[];
  providersLoading?: boolean;
  providerError?: string | null;
  externalLocked?: boolean;
};

function renderWorkspace(initial: Partial<HookProps> = {}) {
  const persistProjectSettings = vi.fn();
  const applyPersistedProject = vi.fn(() => true);
  const updateProjectAiSettingsLocally = vi.fn();
  const onRefreshProviders = vi.fn();
  const navigateToTranscript = vi.fn(() => true);
  const acceptPersistedEvidence = vi.fn();
  const stageExistingCode = vi.fn(() => true);
  const applyAiNote = vi.fn(() => true);
  const addInspectorCode = vi.fn(() => "draft_code_1");
  const codebookTargets = { codeId: "C000001", themeId: "TH000001" };
  let currentCodeForm: CodeForm = { ...emptyCodeForm, codeId: "C000001", name: "Code 1" };
  let currentThemeForm: ThemeForm = { ...emptyThemeForm, themeId: "TH000001", name: "Theme 1", codeIds: ["C000001"] };
  const tryUpdateCodeForm = vi.fn((expectedCodeId: string, updater: (current: CodeForm) => CodeForm) => {
    if (expectedCodeId !== codebookTargets.codeId || currentCodeForm.codeId !== expectedCodeId) return false;
    currentCodeForm = updater(currentCodeForm);
    return true;
  });
  const tryUpdateThemeForm = vi.fn((expectedThemeId: string, updater: (current: ThemeForm) => ThemeForm) => {
    if (expectedThemeId !== codebookTargets.themeId || currentThemeForm.themeId !== expectedThemeId) return false;
    currentThemeForm = updater(currentThemeForm);
    return true;
  });
  const tryOpenNewTheme = vi.fn(() => true);
  const clearDecisionError = vi.fn();
  const onStatusMessage = vi.fn();
  const defaultProject = makeProject();
  const defaultHandle = makeHandle();
  const initialProps: HookProps = {
    project: initial.project === undefined ? defaultProject : initial.project,
    handle: initial.handle === undefined ? defaultHandle : initial.handle,
    providerList: initial.providerList ?? providers,
    providersLoading: initial.providersLoading ?? false,
    providerError: initial.providerError ?? null,
    externalLocked: initial.externalLocked ?? false
  };
  persistProjectSettings.mockImplementation(async () => initialProps.project && initialProps.handle
    ? { project: initialProps.project, handle: initialProps.handle }
    : null);

  const hook = renderHook((props: HookProps) => useCodesContextualAiWorkspace({
    desktopAvailable: true,
    project: props.project,
    projectFile: props.handle?.project_file ?? null,
    providers: props.providerList ?? [],
    providersLoading: props.providersLoading ?? false,
    providerError: props.providerError ?? null,
    onRefreshProviders,
    getCurrentSession: () => ({
      project: props.project,
      projectFile: props.handle?.project_file ?? null,
      projectHandle: props.handle,
      projectConflict: null,
      settingsDirty: false
    }),
    persistProjectSettings,
    applyPersistedProject,
    updateProjectAiSettingsLocally,
    isExternallyLocked: () => Boolean(props.externalLocked),
    getEvidenceWorkspace: () => ({
      evidenceDraft: null,
      evidenceEditDraft: null,
      selectedEvidence,
      navigateToTranscript,
      acceptPersistedEvidence,
      stageExistingCode,
      applyAiNote,
      addInspectorCode
    }),
    getCodebookWorkspace: () => ({
      currentCodeTargetId: () => codebookTargets.codeId,
      currentThemeTargetId: () => codebookTargets.themeId,
      tryUpdateCodeForm,
      tryUpdateThemeForm,
      tryOpenNewTheme
    }),
    clearDecisionError,
    onStatusMessage
  }), { initialProps });

  return {
    ...hook,
    initialProps,
    persistProjectSettings,
    applyPersistedProject,
    updateProjectAiSettingsLocally,
    onRefreshProviders,
    navigateToTranscript,
    acceptPersistedEvidence,
    stageExistingCode,
    applyAiNote,
    addInspectorCode,
    tryUpdateCodeForm,
    tryUpdateThemeForm,
    tryOpenNewTheme,
    codebookTargets,
    currentCodeForm: () => currentCodeForm,
    currentThemeForm: () => currentThemeForm,
    clearDecisionError
  };
}

type ContextualWorkspace = ReturnType<typeof useCodesContextualAiWorkspace>;

function runTask(workspace: ContextualWorkspace, task: CodesAiRunTask) {
  if (task === "evidence") {
    return workspace.runEvidence({
      transcriptId: "T000001",
      scope: { kind: "current_page", segment_ids: ["seg_000001"] },
      researcherPrompt: "Find evidence",
      maximumSuggestions: 10
    });
  }
  if (task === "codes" || task === "note") {
    workspace.setInspectorTarget("evidence:E000001");
    return workspace.runInspector(task, "Analyze evidence");
  }
  if (task === "code_details") {
    const target = { surface: "codebook" as const, instanceId: "dialog-1" };
    workspace.activateCodeDialogTarget(target);
    return workspace.runCodeDetails({
      ...emptyCodeForm,
      name: "Code",
      useCurrentEvidenceAsExample: false
    }, target);
  }
  if (task === "code_refinement") {
    workspace.setCodebookTargets("C000001", "TH000001");
    return workspace.runCodeRefinement({
      ...emptyCodeForm,
      codeId: "C000001",
      name: "Code"
    });
  }
  if (task === "theme_suggestions") return workspace.runThemeSuggestions();
  workspace.setCodebookTargets("C000001", "TH000001");
  return workspace.runThemeRefinement({
    ...emptyThemeForm,
    themeId: "TH000001",
    name: "Theme",
    codeIds: ["C000001"]
  });
}

describe("Codes contextual AI workspace", () => {
  beforeEach(() => {
    apiMocks.start.mockReset().mockImplementation(async (payload: CodesAiRunStartPayload) => (
      startResult(payload, makeRun(payload.task))
    ));
    apiMocks.fetch.mockReset();
    apiMocks.cancel.mockReset();
    apiMocks.models.mockReset().mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "local-model", display_name: "Local Model", details: "", context_length: 8192, is_loaded: true }]
    });
  });

  it("persists current settings first and rejects a synchronous duplicate start", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const hook = renderWorkspace();
    let first!: Promise<boolean>;

    act(() => {
      first = runTask(hook.result.current, "codes");
    });
    expect(hook.result.current.isLocked()).toBe(true);
    await expect(runTask(hook.result.current, "note")).resolves.toBe(false);
    expect(hook.persistProjectSettings).toHaveBeenCalledTimes(1);
    expect(apiMocks.start).toHaveBeenCalledTimes(1);
    expect(hook.persistProjectSettings.mock.invocationCallOrder[0]).toBeLessThan(apiMocks.start.mock.invocationCallOrder[0]);

    await act(async () => {
      const payload = apiMocks.start.mock.calls[0][0] as CodesAiRunStartPayload;
      pending.resolve(startResult(payload, makeRun("codes")));
      await first;
    });
    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(1);
  });

  it("captures nested requests immutably and retries the captured request", async () => {
    apiMocks.start.mockRejectedValueOnce(new Error("provider failed"));
    const hook = renderWorkspace();
    const form = {
      ...emptyThemeForm,
      themeId: "TH000001",
      name: "Theme",
      codeIds: ["C000001"],
      memo: "original"
    };

    await act(async () => {
      await hook.result.current.runThemeRefinement(form);
    });
    form.codeIds.push("C000002");
    form.memo = "changed";
    apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(payload, makeRun("theme_refinement")));

    await act(async () => {
      await hook.result.current.retry("theme_refinement");
    });
    const retryPayload = apiMocks.start.mock.calls[1][0] as CodesAiRunStartPayload;
    expect(retryPayload.theme_draft).toEqual({
      name: "Theme",
      description: "",
      memo: "original",
      code_ids: ["C000001"]
    });
  });

  it("silently drops a late start after the project file is replaced", async () => {
    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValue(pending.promise);
    const hook = renderWorkspace();
    let started!: Promise<boolean>;
    act(() => {
      started = runTask(hook.result.current, "codes");
    });
    await waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));
    hook.rerender({ ...hook.initialProps, handle: makeHandle("project_a", "saved_as") });
    await act(async () => {
      const payload = apiMocks.start.mock.calls[0][0] as CodesAiRunStartPayload;
      pending.resolve(startResult(payload, makeRun("codes")));
      await expect(started).resolves.toBe(false);
    });
    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.result.current.taskError("codes")).toBeNull();
  });

  it("routes every result kind without clearing results from other tasks", async () => {
    const hook = renderWorkspace();
    const taskResults: Array<[CodesAiRunTask, CodesAiRunSnapshot["results"]]> = [
      ["evidence", [evidenceSuggestion]],
      ["codes", [codeSuggestion]],
      ["note", [noteSuggestion]],
      ["code_details", [{
        suggestion_id: "details", run_id: "run_code_details", kind: "code_details", name: "Code", description: "Definition",
        inclusion_note: "Include", exclusion_note: "Exclude", memo: "Note"
      }]],
      ["code_refinement", [{
        suggestion_id: "refinement", run_id: "run_code_refinement", kind: "code_refinement", code_id: "C000001",
        name: "Code", description: "Refined", inclusion_note: "Include", exclusion_note: "Exclude", memo: "Note"
      }]],
      ["theme_suggestions", [themeSuggestion]],
      ["theme_refinement", [{ ...themeSuggestion, suggestion_id: "theme_refinement", run_id: "run_theme_refinement", kind: "theme_refinement", theme_id: "TH000001" }]]
    ];
    for (const [task, results] of taskResults) {
      apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
        payload,
        makeRun(task, { results, omitted: task === "codes" ? [{ reason: "invalid" }] : [] })
      ));
      await act(async () => {
        await runTask(hook.result.current, task);
      });
    }
    expect(hook.result.current.evidenceSuggestions).toHaveLength(1);
    expect(hook.result.current.codeSuggestions).toHaveLength(1);
    expect(hook.result.current.noteSuggestion?.note).toContain("concise");
    expect(hook.result.current.codeDetailsSuggestion?.kind).toBe("code_details");
    expect(hook.result.current.codeRefinementSuggestion?.kind).toBe("code_refinement");
    expect(hook.result.current.themeSuggestions).toHaveLength(1);
    expect(hook.result.current.themeRefinementSuggestion?.kind).toBe("theme_refinement");
    expect(hook.result.current.taskWarning("codes")).toContain("1 invalid suggestion");
    expect(hook.result.current.taskWarning("note")).toBeNull();
  });

  it("hands one authoritative terminal run to suggestions at most once", async () => {
    const hook = renderWorkspace();
    apiMocks.start
      .mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
        payload,
        makeRun("evidence", { results: [evidenceSuggestion] })
      ))
      .mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
        payload,
        makeRun("evidence", {
          results: [{
            ...evidenceSuggestion,
            suggestion_id: "duplicate_terminal_suggestion",
            selected_text: "Duplicate terminal result"
          }]
        })
      ));

    await act(async () => {
      await expect(runTask(hook.result.current, "evidence")).resolves.toBe(true);
    });
    expect(hook.result.current.evidenceSuggestions).toEqual([evidenceSuggestion]);

    await act(async () => {
      await expect(runTask(hook.result.current, "evidence")).resolves.toBe(true);
    });
    expect(hook.result.current.evidenceSuggestions).toEqual([evidenceSuggestion]);
  });

  it("ignores malformed result kinds and mismatched run responses", async () => {
    const hook = renderWorkspace();
    apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
      payload,
      makeRun("codes", { results: [themeSuggestion] })
    ));
    await act(async () => {
      await runTask(hook.result.current, "codes");
    });
    expect(hook.result.current.codeSuggestions).toEqual([]);

    apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
      payload,
      makeRun("note", { task: "evidence", results: [evidenceSuggestion] })
    ));
    await act(async () => {
      await expect(runTask(hook.result.current, "note")).resolves.toBe(false);
    });
    expect(hook.result.current.evidenceSuggestions).toEqual([]);
  });

  it("blocks starts and local applications under an external lock", async () => {
    const hook = renderWorkspace();
    apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
      payload,
      makeRun("codes", { results: [codeSuggestion] })
    ));
    await act(async () => {
      await runTask(hook.result.current, "codes");
    });
    hook.rerender({ ...hook.initialProps, externalLocked: true });
    await act(async () => {
      await expect(runTask(hook.result.current, "note")).resolves.toBe(false);
    });
    expect(apiMocks.start).toHaveBeenCalledTimes(1);
    expect(hook.result.current.taskError("note")).toContain("Another Codes operation");
    expect(hook.result.current.stageAiCode(codeSuggestion, "run_codes")).toBe(false);
    expect(hook.result.current.codeSuggestions).toHaveLength(1);
    expect(hook.result.current.setThemeScope("selected")).toBe(false);
  });

  it("handles cancellation success and failure without leaking stale errors", async () => {
    const hook = renderWorkspace();
    apiMocks.start.mockImplementationOnce(async (payload: CodesAiRunStartPayload) => startResult(
      payload,
      makeRun("codes", { status: "running", phase: "requesting", finished_at: null })
    ));
    apiMocks.cancel.mockResolvedValueOnce(makeRun("codes", { status: "cancelling", phase: "requesting", finished_at: null }));
    await act(async () => {
      await runTask(hook.result.current, "codes");
    });
    await act(async () => {
      await expect(hook.result.current.cancel()).resolves.toBe(true);
    });
    expect(hook.result.current.taskError("codes")).toBeNull();

    apiMocks.fetch.mockResolvedValue(makeRun("codes", { status: "cancelled", phase: "cancelled" }));
    await waitFor(() => expect(hook.result.current.activeWork).toBe(false), { timeout: 2500 });
  });

  it("keeps provider/model errors separate and clears a model only through explicit provider change", async () => {
    const project = makeProject("project_a", "missing-provider", "missing-model");
    const hook = renderWorkspace({ project, providerList: providers, providerError: "Provider refresh failed" });
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.modelError).toBeNull();
    expect(hook.result.current.taskError("codes")).toBeNull();
    await act(async () => {
      await expect(runTask(hook.result.current, "codes")).resolves.toBe(false);
    });
    expect(hook.result.current.settingsOpen).toBe(true);
    expect(hook.result.current.configurationError).toContain("not currently available");
    act(() => {
      hook.result.current.updateSettings({ provider_id: "lmstudio", model_id: "" });
    });
    expect(hook.updateProjectAiSettingsLocally).toHaveBeenCalledWith({ provider_id: "lmstudio", model_id: "" });
  });

  it("blocks a missing configured model without substituting the stored selection", async () => {
    apiMocks.models.mockResolvedValueOnce({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [{ id: "other-model", display_name: "Other Model", details: "", context_length: 8192, is_loaded: true }]
    });
    const hook = renderWorkspace();
    act(() => {
      hook.result.current.setSettingsVisibility(true);
    });
    await waitFor(() => expect(hook.result.current.hasModelSnapshot).toBe(true));
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.configurationError).toContain("local-model is not available");
    expect(hook.result.current.models.map((model) => model.id)).toEqual(["other-model"]);
    expect(hook.updateProjectAiSettingsLocally).not.toHaveBeenCalled();
    expect(hook.result.current.taskError("codes")).toBeNull();
  });

  it("uses the shared provider refresh and rejects refresh during contextual work", async () => {
    const hook = renderWorkspace();
    await act(async () => {
      await expect(hook.result.current.refreshProviders()).resolves.toBe(true);
    });
    expect(hook.onRefreshProviders).toHaveBeenCalledTimes(1);

    const pending = deferred<CodesAiRunMutationPayload>();
    apiMocks.start.mockReturnValueOnce(pending.promise);
    let started!: Promise<boolean>;
    act(() => {
      started = runTask(hook.result.current, "codes");
    });
    await expect(hook.result.current.refreshProviders()).resolves.toBe(false);
    expect(hook.onRefreshProviders).toHaveBeenCalledTimes(1);
    await act(async () => {
      const payload = apiMocks.start.mock.calls.at(-1)?.[0] as CodesAiRunStartPayload;
      pending.resolve(startResult(payload, makeRun("codes")));
      await started;
    });
  });
});
