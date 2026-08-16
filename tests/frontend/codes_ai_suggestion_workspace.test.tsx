import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CodeDialogValue } from "../../src/components/codes/CodesCodeDialog";
import {
  emptyCodeForm,
  emptyThemeForm,
  type CodeForm,
  type EvidenceEditDraft,
  type ThemeForm
} from "../../src/components/codes/codesPageUtils";
import {
  useCodesAiSuggestionWorkspace,
  type ContextualAiRunRequest
} from "../../src/hooks/useCodesAiSuggestionWorkspace";
import type {
  CodesAiDecisionInput,
  CodesAiCodeDetailsSuggestion,
  CodesAiCodeSuggestion,
  CodesAiEvidenceSuggestion,
  CodesAiNoteSuggestion,
  CodesAiRunSnapshot,
  CodesAiRunTask,
  CodesAiThemeSuggestion,
  CodesEvidenceItem,
  CodesProject,
  CodesProjectHandle
} from "../../src/lib/api";

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

function makeProject(projectId = "project_a"): CodesProject {
  return {
    schema_version: "1.1",
    project_id: projectId,
    name: "Study",
    created_at: "2026-08-06T08:00:00Z",
    updated_at: "2026-08-06T08:00:00Z",
    research_focus: "How researchers interpret uncertainty",
    ai_settings: {
      provider_id: "lmstudio",
      model_id: "local-model",
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

const secondEvidenceSuggestion: CodesAiEvidenceSuggestion = {
  ...evidenceSuggestion,
  suggestion_id: "suggestion_evidence_2",
  transcript_id: "T000002"
};

const codeSuggestion: CodesAiCodeSuggestion = {
  suggestion_id: "suggestion_code",
  kind: "existing_code",
  code_id: "C000001",
  name: "Uncertainty",
  description: "",
  rationale: "Matches"
};

const newCodeSuggestion: CodesAiCodeSuggestion = {
  suggestion_id: "suggestion_new_code",
  kind: "new_code",
  name: "Emergent Code",
  description: "Suggested definition",
  rationale: "No existing code fits"
};

const noteSuggestion: CodesAiNoteSuggestion = {
  suggestion_id: "suggestion_note",
  kind: "note",
  note: "A concise analytical note."
};

const codeDetailsSuggestion: CodesAiCodeDetailsSuggestion = {
  suggestion_id: "suggestion_code_details",
  run_id: "run_code_details",
  kind: "code_details",
  name: "Detailed Code",
  description: "Authoritative details.",
  inclusion_note: "Include this.",
  exclusion_note: "Exclude that.",
  memo: "Review this code."
};

const codeRefinementSuggestion: CodesAiCodeDetailsSuggestion = {
  suggestion_id: "suggestion_code_refinement",
  run_id: "run_code_refinement",
  kind: "code_refinement",
  code_id: "C000001",
  name: "Refined Code 1",
  description: "Authoritative code definition.",
  inclusion_note: "Authoritative inclusion.",
  exclusion_note: "Authoritative exclusion.",
  memo: "Authoritative code note."
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

const themeRefinementSuggestion: CodesAiThemeSuggestion = {
  suggestion_id: "suggestion_theme_refinement",
  run_id: "run_theme_refinement",
  kind: "theme_refinement",
  theme_id: "TH000001",
  name: "Refined Theme 1",
  description: "Authoritative theme definition.",
  memo: "Authoritative theme note.",
  code_ids: ["C000001", "C000002"],
  rationale: "Clarifies the grouping."
};

function makeRun(
  task: CodesAiRunTask,
  results: CodesAiRunSnapshot["results"],
  overrides: Partial<CodesAiRunSnapshot> = {}
): CodesAiRunSnapshot {
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
    results,
    omitted: [],
    error: "",
    started_at: "2026-08-06T08:00:00Z",
    finished_at: "2026-08-06T08:00:01Z",
    ...overrides
  };
}

function requestFor(task: CodesAiRunTask): ContextualAiRunRequest {
  if (task === "codes" || task === "note") {
    return { task, researcherPrompt: "Analyze", inspectorTargetKey: "evidence:E000001" };
  }
  if (task === "code_details") {
    return {
      task,
      researcherPrompt: "Draft",
      codeDialogTarget: { surface: "codebook", instanceId: "dialog-1" }
    };
  }
  if (task === "code_refinement") return { task, researcherPrompt: "Refine", codeId: "C000001" };
  if (task === "theme_refinement") return { task, researcherPrompt: "Refine", themeId: "TH000001" };
  return { task, researcherPrompt: "Analyze" };
}

type HookProps = {
  project: CodesProject | null;
  handle: CodesProjectHandle | null;
  runLocked: boolean;
  externalLocked: boolean;
};

function renderSuggestionWorkspace(initial: Partial<HookProps> = {}) {
  const defaultProject = makeProject();
  const defaultHandle = makeHandle();
  const initialProps: HookProps = {
    project: initial.project === undefined ? defaultProject : initial.project,
    handle: initial.handle === undefined ? defaultHandle : initial.handle,
    runLocked: initial.runLocked ?? false,
    externalLocked: initial.externalLocked ?? false
  };
  let currentCodeForm: CodeForm = { ...emptyCodeForm, codeId: "C000001", name: "Code 1" };
  let currentThemeForm: ThemeForm = { ...emptyThemeForm, themeId: "TH000001", name: "Theme 1", codeIds: ["C000001"] };
  let currentEditDraft: EvidenceEditDraft = {
    evidenceId: "E000001",
    memo: "",
    codeIds: [],
    newCodes: [],
    aiDecisions: []
  };
  const codebookTargets = { codeId: "C000001", themeId: "TH000001" };
  const navigateToTranscript = vi.fn(() => true);
  const acceptPersistedEvidence = vi.fn();
  const stageExistingCode = vi.fn((codeId: string, decision?: CodesAiDecisionInput) => {
    if (currentEditDraft.codeIds.includes(codeId)) return false;
    currentEditDraft = {
      ...currentEditDraft,
      codeIds: [...currentEditDraft.codeIds, codeId],
      aiDecisions: decision && typeof decision === "object" && "suggestion_id" in decision
        ? [...currentEditDraft.aiDecisions, decision]
        : currentEditDraft.aiDecisions
    };
    return true;
  });
  const applyAiNote = vi.fn((note: string, mode: "use" | "replace" | "append", decision: EvidenceEditDraft["aiDecisions"][number]) => {
    if (currentEditDraft.aiDecisions.some((item) => item.task === "note" && item.suggestion_id === decision.suggestion_id)) return false;
    currentEditDraft = {
      ...currentEditDraft,
      memo: mode === "append" && currentEditDraft.memo ? `${currentEditDraft.memo}\n\n${note}` : note,
      aiDecisions: [...currentEditDraft.aiDecisions, decision]
    };
    return true;
  });
  const addInspectorCode = vi.fn((value: CodeDialogValue) => {
    const decision = value.aiDecisions.find((item) => item.task === "codes");
    if (decision && currentEditDraft.aiDecisions.some((item) => item.suggestion_id === decision.suggestion_id)) return "";
    currentEditDraft = {
      ...currentEditDraft,
      newCodes: [...currentEditDraft.newCodes, {
        clientId: "draft_code_1",
        name: value.name,
        color: value.color,
        description: value.description,
        inclusionNote: value.inclusionNote,
        exclusionNote: value.exclusionNote,
        exampleEvidenceIds: [...value.exampleEvidenceIds],
        memo: value.memo
      }],
      aiDecisions: [...currentEditDraft.aiDecisions, ...value.aiDecisions]
    };
    return "draft_code_1";
  });
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
  const clearTaskFeedback = vi.fn();
  const clearDecisionError = vi.fn();
  const onStatusMessage = vi.fn();

  const hook = renderHook((props: HookProps) => useCodesAiSuggestionWorkspace({
    project: props.project,
    projectFile: props.handle?.project_file ?? null,
    getCurrentSession: () => ({
      project: props.project,
      projectFile: props.handle?.project_file ?? null,
      projectHandle: props.handle,
      projectConflict: null,
      settingsDirty: false
    }),
    getEvidenceWorkspace: () => ({
      evidenceDraft: null,
      evidenceEditDraft: currentEditDraft,
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
    isRunLocked: () => props.runLocked,
    isExternallyLocked: () => props.externalLocked,
    clearTaskFeedback,
    clearDecisionError,
    onStatusMessage
  }), { initialProps });

  return {
    ...hook,
    initialProps,
    navigateToTranscript,
    acceptPersistedEvidence,
    stageExistingCode,
    applyAiNote,
    addInspectorCode,
    tryUpdateCodeForm,
    tryUpdateThemeForm,
    tryOpenNewTheme,
    clearTaskFeedback,
    clearDecisionError,
    codebookTargets,
    currentCodeForm: () => currentCodeForm,
    currentThemeForm: () => currentThemeForm,
    currentEditDraft: () => currentEditDraft
  };
}

function prepareAllTargets(workspace: ReturnType<typeof renderSuggestionWorkspace>["result"]["current"]) {
  workspace.actions.setInspectorTarget("evidence:E000001");
  workspace.actions.activateCodeDialogTarget({ surface: "codebook", instanceId: "dialog-1" });
  workspace.actions.setCodebookTargets("C000001", "TH000001");
}

function routeAllResults(workspace: ReturnType<typeof renderSuggestionWorkspace>["result"]["current"]) {
  workspace.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion, secondEvidenceSuggestion]), requestFor("evidence"));
  workspace.coordinator.routeCompletedRun(makeRun("codes", [codeSuggestion, newCodeSuggestion]), requestFor("codes"));
  workspace.coordinator.routeCompletedRun(makeRun("note", [noteSuggestion]), requestFor("note"));
  workspace.coordinator.routeCompletedRun(makeRun("code_details", [codeDetailsSuggestion]), requestFor("code_details"));
  workspace.coordinator.routeCompletedRun(makeRun("code_refinement", [codeRefinementSuggestion]), requestFor("code_refinement"));
  workspace.coordinator.routeCompletedRun(makeRun("theme_suggestions", [themeSuggestion]), requestFor("theme_suggestions"));
  workspace.coordinator.routeCompletedRun(makeRun("theme_refinement", [themeRefinementSuggestion]), requestFor("theme_refinement"));
}

describe("Codes AI suggestion workspace", () => {
  it("routes authoritative results for every task and resets them for project or file replacement", async () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      prepareAllTargets(hook.result.current);
      routeAllResults(hook.result.current);
    });

    expect(hook.result.current.state.evidenceSuggestions).toHaveLength(2);
    expect(hook.result.current.state.selectedEvidenceSuggestionId).toBe(evidenceSuggestion.suggestion_id);
    expect(hook.result.current.state.codeSuggestions).toHaveLength(2);
    expect(hook.result.current.state.noteSuggestion).toEqual(noteSuggestion);
    expect(hook.result.current.state.codeDetailsSuggestion).toEqual(codeDetailsSuggestion);
    expect(hook.result.current.state.codeRefinementSuggestion).toEqual(codeRefinementSuggestion);
    expect(hook.result.current.state.themeSuggestions).toEqual([themeSuggestion]);
    expect(hook.result.current.state.themeRefinementSuggestion).toEqual(themeRefinementSuggestion);

    hook.rerender({ ...hook.initialProps, handle: makeHandle("project_a", "saved_as") });
    await waitFor(() => expect(hook.result.current.state.evidenceSuggestions).toEqual([]));
    expect(hook.result.current.state.resultRunIds).toEqual({});

    hook.rerender({ ...hook.initialProps, project: makeProject("project_b"), handle: makeHandle("project_b") });
    await waitFor(() => expect(hook.result.current.state.codeSuggestions).toEqual([]));
  });

  it("binds Inspector, Code Dialog, code-refinement, and theme-refinement results to exact targets", () => {
    const hook = renderSuggestionWorkspace();
    act(() => prepareAllTargets(hook.result.current));

    expect(hook.result.current.coordinator.requestTargetIsCurrent(requestFor("codes"))).toBe(true);
    expect(hook.result.current.coordinator.requestTargetIsCurrent({ ...requestFor("codes"), inspectorTargetKey: "evidence:E999999" })).toBe(false);
    expect(hook.result.current.coordinator.requestTargetIsCurrent(requestFor("code_details"))).toBe(true);
    expect(hook.result.current.coordinator.requestTargetIsCurrent({
      ...requestFor("code_details"),
      codeDialogTarget: { surface: "inspector", instanceId: "dialog-1" }
    })).toBe(false);
    expect(hook.result.current.coordinator.requestTargetIsCurrent(requestFor("code_refinement"))).toBe(true);
    expect(hook.result.current.coordinator.requestTargetIsCurrent({ ...requestFor("code_refinement"), codeId: "C000002" })).toBe(false);
    expect(hook.result.current.coordinator.requestTargetIsCurrent(requestFor("theme_refinement"))).toBe(true);
    expect(hook.result.current.coordinator.requestTargetIsCurrent({ ...requestFor("theme_refinement"), themeId: "TH000002" })).toBe(false);
  });

  it("keeps Evidence selection transactional when transcript navigation succeeds or fails", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion, secondEvidenceSuggestion]), requestFor("evidence"));
    });
    hook.navigateToTranscript.mockReturnValueOnce(false);
    expect(hook.result.current.actions.selectEvidenceSuggestion(secondEvidenceSuggestion)).toBe(false);
    expect(hook.result.current.state.selectedEvidenceSuggestionId).toBe(evidenceSuggestion.suggestion_id);

    act(() => {
      expect(hook.result.current.actions.selectEvidenceSuggestion(secondEvidenceSuggestion)).toBe(true);
    });
    expect(hook.result.current.state.selectedEvidenceSuggestionId).toBe(secondEvidenceSuggestion.suggestion_id);
    expect(hook.navigateToTranscript).toHaveBeenLastCalledWith("T000002");
  });

  it("completes persisted Evidence acceptance and rejection through authoritative callbacks", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion, secondEvidenceSuggestion]), requestFor("evidence"));
      hook.result.current.actions.handleEvidenceAccepted({
        suggestion: evidenceSuggestion,
        payload: {
          project: makeProject(),
          handle: makeHandle(),
          project_file: makeHandle().project_file,
          project_id: "project_a",
          revision: makeHandle().revision,
          evidence: { ...selectedEvidence, evidence_id: "E000002" },
          created_codes: []
        }
      });
    });
    expect(hook.acceptPersistedEvidence).toHaveBeenCalledWith(expect.objectContaining({ evidence_id: "E000002" }));
    expect(hook.result.current.state.evidenceSuggestions).toEqual([secondEvidenceSuggestion]);

    act(() => hook.result.current.actions.handleSuggestionRejected({
      task: "evidence",
      suggestionId: secondEvidenceSuggestion.suggestion_id,
      runId: secondEvidenceSuggestion.run_id
    }));
    expect(hook.result.current.state.evidenceSuggestions).toEqual([]);
  });

  it("ignores stale persisted callbacks when a newer run reuses a suggestion identity", () => {
    const hook = renderSuggestionWorkspace();
    const current = { ...evidenceSuggestion, run_id: "run_current" };
    const stale = { ...current, run_id: "run_stale" };
    const payload = {
      project: makeProject(),
      handle: makeHandle(),
      project_file: makeHandle().project_file,
      project_id: "project_a",
      revision: makeHandle().revision,
      evidence: { ...selectedEvidence, evidence_id: "E000002" },
      created_codes: []
    };

    act(() => {
      hook.result.current.coordinator.routeCompletedRun(
        makeRun("evidence", [current, secondEvidenceSuggestion], { run_id: current.run_id }),
        requestFor("evidence")
      );
      hook.result.current.actions.handleEvidenceAccepted({ suggestion: stale, payload });
      hook.result.current.actions.handleSuggestionRejected({
        task: "evidence",
        suggestionId: stale.suggestion_id,
        runId: stale.run_id
      });
    });
    expect(hook.acceptPersistedEvidence).not.toHaveBeenCalled();
    expect(hook.navigateToTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.state.evidenceSuggestions).toEqual([current, secondEvidenceSuggestion]);

    act(() => {
      hook.result.current.actions.handleEvidenceAccepted({ suggestion: current, payload });
      hook.result.current.actions.handleEvidenceAccepted({ suggestion: current, payload });
    });
    expect(hook.acceptPersistedEvidence).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.evidenceSuggestions).toEqual([secondEvidenceSuggestion]);

    act(() => {
      hook.result.current.coordinator.routeCompletedRun(
        makeRun("evidence", [current, secondEvidenceSuggestion], { run_id: current.run_id }),
        requestFor("evidence")
      );
      hook.result.current.actions.handleSuggestionRejected({
        task: "evidence",
        suggestionId: current.suggestion_id,
        runId: current.run_id
      });
      hook.result.current.actions.handleSuggestionRejected({
        task: "evidence",
        suggestionId: current.suggestion_id,
        runId: current.run_id
      });
    });
    expect(hook.navigateToTranscript).toHaveBeenCalledTimes(1);
  });

  it("retains Inspector suggestions when their destination rejects the mutation", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setInspectorTarget("evidence:E000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("codes", [codeSuggestion, newCodeSuggestion]), requestFor("codes"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("note", [noteSuggestion]), requestFor("note"));
    });

    hook.stageExistingCode.mockReturnValueOnce(false);
    expect(hook.result.current.actions.stageAiCode(codeSuggestion, "run_codes")).toBe(false);
    expect(hook.result.current.state.codeSuggestions).toEqual([codeSuggestion, newCodeSuggestion]);

    hook.addInspectorCode.mockReturnValueOnce("");
    expect(hook.result.current.actions.addInspectorCode({ ...emptyCodeForm, name: "Draft" }, newCodeSuggestion, "run_codes")).toBe("");
    expect(hook.result.current.state.codeSuggestions).toEqual([codeSuggestion, newCodeSuggestion]);
    expect(hook.currentEditDraft().aiDecisions).toEqual([]);

    hook.applyAiNote.mockReturnValueOnce(false);
    expect(hook.result.current.actions.applyAiNote(noteSuggestion, "run_note", "replace")).toBe(false);
    expect(hook.result.current.state.noteSuggestion).toEqual(noteSuggestion);
  });

  it("retains code-refinement suggestions when the Codebook destination rejects them", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setCodebookTargets("C000001", "TH000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("code_refinement", [codeRefinementSuggestion]), requestFor("code_refinement"));
    });
    hook.tryUpdateCodeForm.mockReturnValueOnce(false);
    expect(hook.result.current.actions.applyCodeRefinement(codeRefinementSuggestion)).toBe(false);
    expect(hook.result.current.state.codeRefinementSuggestion).toEqual(codeRefinementSuggestion);
  });

  it("retains theme suggestions when creation or editing destinations reject them", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setCodebookTargets("C000001", "TH000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("theme_suggestions", [themeSuggestion]), requestFor("theme_suggestions"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("theme_refinement", [themeRefinementSuggestion]), requestFor("theme_refinement"));
    });
    hook.tryOpenNewTheme.mockReturnValueOnce(false);
    expect(hook.result.current.actions.acceptThemeSuggestion(themeSuggestion)).toBe(false);
    expect(hook.result.current.state.themeSuggestions).toEqual([themeSuggestion]);

    hook.tryUpdateThemeForm.mockReturnValueOnce(false);
    expect(hook.result.current.actions.applyThemeRefinement(themeRefinementSuggestion)).toBe(false);
    expect(hook.result.current.state.themeRefinementSuggestion).toEqual(themeRefinementSuggestion);
  });

  it("rejects late completed Evidence results after the Inspector target is replaced", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion]), requestFor("evidence"));
      hook.result.current.actions.setInspectorTarget("evidence:E000001");
    });
    const request = requestFor("codes");
    act(() => {
      hook.result.current.actions.setInspectorTarget("evidence:E000002");
    });
    expect(hook.result.current.coordinator.routeCompletedRun(makeRun("codes", [codeSuggestion]), request)).toBe(false);
    expect(hook.result.current.state.resultRunIds.codes).toBeUndefined();
    expect(hook.result.current.state.evidenceSuggestions).toEqual([evidenceSuggestion]);
  });

  it("rejects late completed Code Dialog results after the dialog instance is replaced", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion]), requestFor("evidence"));
      hook.result.current.actions.activateCodeDialogTarget({ surface: "codebook", instanceId: "dialog-1" });
    });
    const request = requestFor("code_details");
    act(() => {
      hook.result.current.actions.activateCodeDialogTarget({ surface: "codebook", instanceId: "dialog-2" });
    });
    expect(hook.result.current.coordinator.routeCompletedRun(makeRun("code_details", [codeDetailsSuggestion]), request)).toBe(false);
    expect(hook.result.current.state.resultRunIds.code_details).toBeUndefined();
    expect(hook.result.current.state.evidenceSuggestions).toEqual([evidenceSuggestion]);
  });

  it("rejects late completed code-refinement results after the code target is replaced", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion]), requestFor("evidence"));
      hook.result.current.actions.setCodebookTargets("C000001", "TH000001");
    });
    const request = requestFor("code_refinement");
    act(() => {
      hook.result.current.actions.setCodebookTargets("C000002", "TH000001");
    });
    hook.codebookTargets.codeId = "C000002";
    expect(hook.result.current.coordinator.routeCompletedRun(makeRun("code_refinement", [codeRefinementSuggestion]), request)).toBe(false);
    expect(hook.result.current.state.resultRunIds.code_refinement).toBeUndefined();
    expect(hook.result.current.state.evidenceSuggestions).toEqual([evidenceSuggestion]);
  });

  it("rejects late completed theme-refinement results after the theme target is replaced", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion]), requestFor("evidence"));
      hook.result.current.actions.setCodebookTargets("C000001", "TH000001");
    });
    const request = requestFor("theme_refinement");
    act(() => {
      hook.result.current.actions.setCodebookTargets("C000001", "TH000002");
    });
    hook.codebookTargets.themeId = "TH000002";
    expect(hook.result.current.coordinator.routeCompletedRun(makeRun("theme_refinement", [themeRefinementSuggestion]), request)).toBe(false);
    expect(hook.result.current.state.resultRunIds.theme_refinement).toBeUndefined();
    expect(hook.result.current.state.evidenceSuggestions).toEqual([evidenceSuggestion]);
  });

  it("clears decision errors selectively when Inspector targets change", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setInspectorTarget("evidence:E000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("codes", [codeSuggestion, newCodeSuggestion]), requestFor("codes"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("note", [noteSuggestion]), requestFor("note"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("evidence", [evidenceSuggestion]), requestFor("evidence"));
      hook.clearDecisionError.mockClear();
      hook.result.current.actions.setInspectorTarget("evidence:E000002");
    });
    expect(hook.clearDecisionError).toHaveBeenCalledWith("codes", codeSuggestion.suggestion_id);
    expect(hook.clearDecisionError).toHaveBeenCalledWith("note", noteSuggestion.suggestion_id);
    expect(hook.clearDecisionError).toHaveBeenCalledWith("codes", newCodeSuggestion.suggestion_id);
    expect(hook.clearDecisionError).not.toHaveBeenCalledWith("evidence", evidenceSuggestion.suggestion_id);
    expect(hook.result.current.state.codeSuggestions).toEqual([]);
    expect(hook.result.current.state.noteSuggestion).toBeNull();
  });

  it("stages existing codes, provisional codes, and notes from authoritative results in one render batch", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setInspectorTarget("evidence:E000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("codes", [codeSuggestion, newCodeSuggestion]), requestFor("codes"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("note", [noteSuggestion]), requestFor("note"));
    });

    const provisional: CodeDialogValue = {
      ...emptyCodeForm,
      name: "Researcher Edited Name",
      description: "Researcher edited definition",
      useCurrentEvidenceAsExample: false
    };
    act(() => {
      expect(hook.result.current.actions.stageAiCode({ ...codeSuggestion, name: "Caller tampering" }, "run_codes")).toBe(true);
      expect(hook.result.current.actions.addInspectorCode(provisional, { ...newCodeSuggestion, name: "Caller tampering" }, "run_codes")).toBe("draft_code_1");
      expect(hook.result.current.actions.applyAiNote({ ...noteSuggestion, note: "Caller tampering" }, "run_note", "replace")).toBe(true);
    });

    expect(hook.stageExistingCode).toHaveBeenCalledWith("C000001", expect.objectContaining({ suggestion_id: codeSuggestion.suggestion_id }));
    expect(hook.addInspectorCode).toHaveBeenCalledWith(expect.objectContaining({
      name: "Researcher Edited Name",
      description: "Researcher edited definition"
    }));
    expect(hook.applyAiNote).toHaveBeenCalledWith(noteSuggestion.note, "replace", expect.objectContaining({
      suggestion_id: noteSuggestion.suggestion_id
    }));
    expect(hook.currentEditDraft().aiDecisions.map((item) => item.suggestion_id)).toEqual([
      codeSuggestion.suggestion_id,
      newCodeSuggestion.suggestion_id,
      noteSuggestion.suggestion_id
    ]);
  });

  it("prevents same-batch duplicate provisional-code acceptance without changing manual provisional behavior", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setInspectorTarget("evidence:E000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("codes", [newCodeSuggestion]), requestFor("codes"));
    });
    const value: CodeDialogValue = {
      ...emptyCodeForm,
      name: "Edited Name",
      useCurrentEvidenceAsExample: false
    };
    act(() => {
      expect(hook.result.current.actions.addInspectorCode(value, newCodeSuggestion, "run_codes")).toBe("draft_code_1");
      expect(hook.result.current.actions.addInspectorCode(value, newCodeSuggestion, "run_codes")).toBe("");
      expect(hook.result.current.actions.addInspectorCode(value)).toBe("draft_code_1");
    });
    expect(hook.currentEditDraft().aiDecisions.filter((item) => item.suggestion_id === newCodeSuggestion.suggestion_id)).toHaveLength(1);
  });

  it("authorizes Code Details transactionally for one dialog instance and surface", () => {
    const hook = renderSuggestionWorkspace();
    const target = { surface: "codebook" as const, instanceId: "dialog-1" };
    act(() => {
      hook.result.current.actions.activateCodeDialogTarget(target);
      hook.result.current.coordinator.routeCompletedRun(makeRun("code_details", [codeDetailsSuggestion]), requestFor("code_details"));
    });
    expect(hook.result.current.actions.authorizeCodeDetailsSuggestion(
      { surface: "inspector", instanceId: "dialog-1" },
      codeDetailsSuggestion
    )).toBeNull();
    expect(hook.result.current.actions.authorizeCodeDetailsSuggestion(target, {
      ...codeDetailsSuggestion,
      description: "Caller tampering"
    })).toEqual(codeDetailsSuggestion);
    expect(hook.result.current.actions.authorizeCodeDetailsSuggestion(target, codeDetailsSuggestion)).toBeNull();
  });

  it("applies code refinement, theme creation, and theme refinement only to exact current targets", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      hook.result.current.actions.setCodebookTargets("C000001", "TH000001");
      hook.result.current.coordinator.routeCompletedRun(makeRun("code_refinement", [codeRefinementSuggestion]), requestFor("code_refinement"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("theme_suggestions", [themeSuggestion]), requestFor("theme_suggestions"));
      hook.result.current.coordinator.routeCompletedRun(makeRun("theme_refinement", [themeRefinementSuggestion]), requestFor("theme_refinement"));
    });
    expect(hook.result.current.actions.applyCodeRefinement({ ...codeRefinementSuggestion, description: "Caller tampering" })).toBe(true);
    expect(hook.currentCodeForm().description).toBe(codeRefinementSuggestion.description);
    expect(hook.result.current.actions.acceptThemeSuggestion({ ...themeSuggestion, description: "Caller tampering" })).toBe(true);
    expect(hook.tryOpenNewTheme).toHaveBeenCalledWith(expect.objectContaining({ description: themeSuggestion.description }));
    expect(hook.result.current.actions.applyThemeRefinement({ ...themeRefinementSuggestion, memo: "Caller tampering" })).toBe(true);
    expect(hook.currentThemeForm().memo).toBe(themeRefinementSuggestion.memo);
  });

  it("selectively reconciles transcript, code, theme, scope, and decision-error state", async () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      prepareAllTargets(hook.result.current);
      routeAllResults(hook.result.current);
      hook.result.current.actions.setThemeScope("selected");
      hook.result.current.actions.toggleThemeScopeCode("C000001");
      hook.result.current.actions.toggleThemeScopeCode("C000002");
    });
    const reduced = makeProject();
    reduced.transcripts = reduced.transcripts.filter((item) => item.transcript_id !== "T000001");
    reduced.codes = reduced.codes.filter((item) => item.code_id !== "C000001");
    reduced.themes = reduced.themes.filter((item) => item.theme_id !== "TH000001");
    hook.rerender({ ...hook.initialProps, project: reduced });

    await waitFor(() => expect(hook.result.current.state.evidenceSuggestions).toEqual([secondEvidenceSuggestion]));
    expect(hook.result.current.state.codeSuggestions).toEqual([newCodeSuggestion]);
    expect(hook.result.current.state.themeSelectedCodeIds).toEqual(["C000002"]);
    expect(hook.result.current.state.codeRefinementSuggestion).toBeNull();
    expect(hook.result.current.state.themeRefinementSuggestion).toBeNull();
    expect(hook.result.current.state.noteSuggestion).toEqual(noteSuggestion);
    expect(hook.clearDecisionError).toHaveBeenCalledWith("evidence", evidenceSuggestion.suggestion_id);
    expect(hook.clearDecisionError).toHaveBeenCalledWith("codes", codeSuggestion.suggestion_id);
  });

  it("rejects result application and UI actions under run or external locking", () => {
    const hook = renderSuggestionWorkspace({ externalLocked: true });
    act(() => prepareAllTargets(hook.result.current));
    expect(hook.result.current.actions.setThemeScope("selected")).toBe(false);
    expect(hook.result.current.actions.selectEvidenceSuggestion(evidenceSuggestion)).toBe(false);
    expect(hook.result.current.actions.stageAiCode(codeSuggestion, "run_codes")).toBe(false);

    hook.rerender({ ...hook.initialProps, externalLocked: false, runLocked: true });
    expect(hook.result.current.actions.toggleThemeScopeCode("C000001")).toBe(false);
    expect(hook.result.current.actions.applyAiNote(noteSuggestion, "run_note", "replace")).toBe(false);
  });

  it("clears only destination-bound results when Inspector, dialog, code, or theme targets change", () => {
    const hook = renderSuggestionWorkspace();
    act(() => {
      prepareAllTargets(hook.result.current);
      routeAllResults(hook.result.current);
      hook.result.current.actions.setInspectorTarget("evidence:E000002");
      hook.result.current.actions.activateCodeDialogTarget({ surface: "codebook", instanceId: "dialog-2" });
      hook.result.current.actions.setCodebookTargets("C000002", "TH000002");
    });
    expect(hook.result.current.state.codeSuggestions).toEqual([]);
    expect(hook.result.current.state.noteSuggestion).toBeNull();
    expect(hook.result.current.state.codeDetailsSuggestion).toBeNull();
    expect(hook.result.current.state.codeRefinementSuggestion).toBeNull();
    expect(hook.result.current.state.themeRefinementSuggestion).toBeNull();
    expect(hook.result.current.state.evidenceSuggestions).toHaveLength(2);
    expect(hook.result.current.state.themeSuggestions).toEqual([themeSuggestion]);
  });
});
