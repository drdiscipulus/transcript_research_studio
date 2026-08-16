import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodesEvidenceDeleteDialog } from "../../src/components/codes/CodesEvidenceDeleteDialog";
import { CodesTranscriptActionDialog } from "../../src/components/codes/CodesTranscriptActionDialog";
import type { CodeDialogValue } from "../../src/components/codes/CodesCodeDialog";
import { useCodesEvidenceWorkspace } from "../../src/hooks/useCodesEvidenceWorkspace";
import {
  ApiError,
  CodesProjectConflictError,
  type CodesAiDecisionInput,
  type CodesEvidenceItem,
  type CodesProject,
  type CodesProjectHandle,
  type CodesTranscript
} from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  createEvidence: vi.fn(),
  updateEvidence: vi.fn(),
  deleteEvidence: vi.fn(),
  removeTranscript: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    createCodesEvidenceItem: apiMocks.createEvidence,
    updateCodesEvidenceItem: apiMocks.updateEvidence,
    deleteCodesEvidenceItem: apiMocks.deleteEvidence,
    removeCodesProjectTranscript: apiMocks.removeTranscript
  };
});

const transcriptOne: CodesTranscript = {
  transcript_id: "T000001",
  label: "Interview one",
  source_file: "D:\\research\\interview-one.json",
  source_document_id: "document-one",
  imported_at: "",
  refreshed_at: null,
  language: "en",
  speakers: [{ id: "SPEAKER_00", name: "Participant" }],
  segments: [
    { segment_id: "seg_1", start: 0, end: 2, speaker: "SPEAKER_00", text: "  Alpha beta  " },
    { segment_id: "seg_2", start: 2, end: 4, speaker: "SPEAKER_00", text: "Gamma delta" }
  ],
  metadata: {},
  validation_issues: []
};

const transcriptTwo: CodesTranscript = {
  ...transcriptOne,
  transcript_id: "T000002",
  label: "Interview two",
  source_file: "D:\\research\\interview-two.json",
  source_document_id: "document-two"
};

function makeEvidence(overrides: Partial<CodesEvidenceItem> = {}): CodesEvidenceItem {
  return {
    evidence_id: "E000001",
    transcript_id: transcriptOne.transcript_id,
    source_file: transcriptOne.source_file,
    source_document_id: transcriptOne.source_document_id,
    segment_ids: ["seg_1"],
    speaker: "SPEAKER_00",
    start: 0,
    end: 2,
    selected_text: "Alpha",
    segment_ranges: { seg_1: { start_offset: 2, end_offset: 7, excerpt: "Alpha" } },
    code_ids: ["C000001"],
    memo: "Saved note",
    created_at: "",
    updated_at: "",
    ...overrides
  };
}

function makeProject(overrides: Partial<CodesProject> = {}): CodesProject {
  return {
    schema_version: "1.1",
    project_id: "project_a",
    name: "Study",
    created_at: "",
    updated_at: "",
    research_focus: "",
    ai_settings: {
      provider_id: "",
      model_id: "",
      temperature: 0,
      timeout_seconds: 180,
      suggestion_language: "auto"
    },
    transcripts: [transcriptOne, transcriptTwo],
    evidence_items: [makeEvidence()],
    codes: [
      { code_id: "C000001", name: "First", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#0f766e", memo: "", created_at: "", updated_at: "" },
      { code_id: "C000002", name: "Second", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#1d4ed8", memo: "", created_at: "", updated_at: "" }
    ],
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
    id_counters: {},
    ...overrides
  };
}

function makeHandle(revision = "a", file = "project_a", projectId = "project_a"): CodesProjectHandle {
  return {
    project_file: `D:\\research\\${file}.evidence.json`,
    project_id: projectId,
    revision: revision.repeat(64)
  };
}

function persisted(project = makeProject(), handle = makeHandle()) {
  return { project, handle };
}

function mutationPayload<T extends Record<string, unknown>>(project: CodesProject, handle: CodesProjectHandle, extra: T) {
  return {
    project,
    handle,
    project_id: handle.project_id,
    project_file: handle.project_file,
    revision: handle.revision,
    ...extra
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const selection = {
  transcriptId: transcriptOne.transcript_id,
  segmentIds: ["seg_1", "seg_2"],
  selectedText: "Alpha Gamma",
  segmentRanges: {
    seg_1: { start_offset: 2, end_offset: 7, excerpt: "Alpha" },
    seg_2: { start_offset: 0, end_offset: 5, excerpt: "Gamma" }
  }
};

const acceptedDecision: CodesAiDecisionInput = {
  run_id: "run_1",
  suggestion_id: "suggestion_1",
  task: "codes",
  decision: "accepted",
  result_ids: ["C000001"]
};

function codeDialogValue(overrides: Partial<CodeDialogValue> = {}): CodeDialogValue {
  return {
    codeId: null,
    name: "Emergent code",
    description: "Full definition",
    inclusionNote: "Include this",
    exclusionNote: "Exclude that",
    exampleEvidenceIds: ["E000001"],
    color: "#123456",
    memo: "Code note",
    aiDecisions: [acceptedDecision],
    useCurrentEvidenceAsExample: true,
    ...overrides
  };
}

type Persisted = ReturnType<typeof persisted>;

function renderWorkspace(options: {
  initial?: Persisted;
  externallyLocked?: { current: boolean };
  persist?: { current: () => Promise<Persisted | null> };
} = {}) {
  const conflicts: CodesProjectConflictError[] = [];
  const errors: Array<{ error: unknown; fallback: string }> = [];
  const statuses: string[] = [];
  const busyChanges: boolean[] = [];
  const externalLock = options.externallyLocked ?? { current: false };
  const hook = renderHook(() => {
    const [session, setSession] = useState(() => options.initial ?? persisted());
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const replaceSession = useCallback((next: Persisted) => {
      sessionRef.current = next;
      setSession(next);
    }, []);
    const getCurrentSession = useCallback(() => ({
      project: sessionRef.current.project,
      projectFile: sessionRef.current.handle.project_file,
      projectHandle: sessionRef.current.handle,
      projectConflict: null,
      settingsDirty: false
    }), []);
    const applyPersistedProject = useCallback((next: Persisted) => {
      const current = sessionRef.current;
      if (
        current.project.project_id !== next.project.project_id
        || current.handle.project_file !== next.handle.project_file
      ) return false;
      replaceSession(next);
      return true;
    }, [replaceSession]);
    return {
      session,
      replaceSession,
      workspace: useCodesEvidenceWorkspace({
        getCurrentSession,
        applyPersistedProject,
        persistProjectSettings: () => options.persist?.current() ?? Promise.resolve(sessionRef.current),
        isExternallyLocked: () => externalLock.current,
        onBusyChange: (busy) => busyChanges.push(busy),
        onProjectConflict: (conflict) => conflicts.push(conflict),
        onStatusMessage: (status) => statuses.push(status),
        onError: (error, fallback) => errors.push({ error, fallback })
      })
    };
  });
  return { ...hook, conflicts, errors, statuses, busyChanges, externalLock };
}

function nextEvidencePayload(request: {
  project: CodesProject;
  evidence_id?: string;
  transcript_id?: string;
  selected_text?: string;
  segment_ids?: string[];
  segment_ranges?: CodesEvidenceItem["segment_ranges"];
  code_ids?: string[];
  memo?: string;
}) {
  const evidence = request.evidence_id
    ? {
        ...request.project.evidence_items.find((item) => item.evidence_id === request.evidence_id)!,
        code_ids: request.code_ids ?? [],
        memo: request.memo ?? ""
      }
    : makeEvidence({
        evidence_id: "E000002",
        transcript_id: request.transcript_id,
        selected_text: request.selected_text,
        segment_ids: request.segment_ids,
        segment_ranges: request.segment_ranges,
        code_ids: request.code_ids ?? [],
        memo: request.memo ?? ""
      });
  const project = request.evidence_id
    ? { ...request.project, evidence_items: request.project.evidence_items.map((item) => item.evidence_id === evidence.evidence_id ? evidence : item) }
    : { ...request.project, evidence_items: [...request.project.evidence_items, evidence] };
  const handle = makeHandle("b");
  return mutationPayload(project, handle, { evidence });
}

describe("Codes evidence workspace lifecycle", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
  });

  it("captures exact ordered multi-segment anchors and whitespace-trimmed offsets", () => {
    const { result } = renderWorkspace();
    act(() => expect(result.current.workspace.captureSelection(selection)).toBe(true));
    expect(result.current.workspace.evidenceDraft).toEqual(expect.objectContaining({
      segmentIds: ["seg_1", "seg_2"],
      selectedText: "Alpha Gamma",
      segmentRanges: selection.segmentRanges
    }));
  });

  it.each([
    [{ ...selection, selectedText: "" }],
    [{ ...selection, transcriptId: "outside" }],
    [{ ...selection, segmentIds: ["seg_2", "seg_1"] }],
    [{ ...selection, segmentRanges: { ...selection.segmentRanges, seg_1: { start_offset: 0, end_offset: 5, excerpt: "Alpha" } } }]
  ])("rejects empty, outside, reversed, or offset-invalid selections", (invalidSelection) => {
    const { result } = renderWorkspace();
    act(() => expect(result.current.workspace.captureSelection(invalidSelection)).toBe(false));
    expect(result.current.workspace.evidenceDraft).toBeNull();
  });

  it("replaces only draft anchors while preserving memo, codes, provisional codes, and AI decisions", () => {
    const { result } = renderWorkspace();
    act(() => result.current.workspace.captureSelection({
        transcriptId: transcriptOne.transcript_id,
        segmentIds: ["seg_1"],
        selectedText: "Alpha",
        segmentRanges: { seg_1: { start_offset: 2, end_offset: 7, excerpt: "Alpha" } }
      }));
    act(() => result.current.workspace.updateInspectorMemo("Analytical note"));
    act(() => result.current.workspace.stageExistingCode("C000002", acceptedDecision));
    act(() => result.current.workspace.addInspectorCode(codeDialogValue({
      aiDecisions: [{ ...acceptedDecision, suggestion_id: "provisional_1" }]
    })));
    act(() => expect(result.current.workspace.captureSelection(selection)).toBe(true));
    expect(result.current.workspace.evidenceDraft).toEqual(expect.objectContaining({
      selectedText: "Alpha Gamma",
      codeIds: ["C000002"],
      memo: "Analytical note"
    }));
    expect(result.current.workspace.evidenceDraft?.newCodes).toHaveLength(1);
    expect(result.current.workspace.evidenceDraft?.aiDecisions).toContainEqual(acceptedDecision);
  });

  it("toggles assignments and edits saved-evidence notes only in the local draft", () => {
    const { result } = renderWorkspace();
    act(() => {
      result.current.workspace.selectEvidence(makeEvidence());
      result.current.workspace.toggleInspectorCode("C000001");
      result.current.workspace.toggleInspectorCode("C000002");
      result.current.workspace.updateInspectorMemo("Local revision");
    });
    expect(result.current.workspace.evidenceEditDraft).toEqual(expect.objectContaining({
      codeIds: ["C000002"],
      memo: "Local revision"
    }));
    expect(result.current.session.project.evidence_items[0]).toEqual(expect.objectContaining({
      code_ids: ["C000001"],
      memo: "Saved note"
    }));
  });

  it("maps every provisional-code field and retains its AI decisions in an immutable create payload", async () => {
    const pendingSettings = deferred<Persisted>();
    const pendingResponse = deferred<unknown>();
    const harness = renderWorkspace({ persist: { current: () => pendingSettings.promise } });
    apiMocks.createEvidence.mockReturnValueOnce(pendingResponse.promise);
    act(() => harness.result.current.workspace.captureSelection(selection));
    act(() => harness.result.current.workspace.addInspectorCode(codeDialogValue()));
    let saving!: Promise<boolean>;
    act(() => { saving = harness.result.current.workspace.saveEvidenceDraft(); });
    act(() => {
      harness.result.current.workspace.updateInspectorMemo("Late edit");
      harness.result.current.workspace.addInspectorCode(codeDialogValue({ name: "Late code" }));
    });
    await act(async () => { pendingSettings.resolve(persisted()); await Promise.resolve(); });
    expect(apiMocks.createEvidence).toHaveBeenCalledOnce();
    const request = apiMocks.createEvidence.mock.calls[0][0];
    const response = nextEvidencePayload(request);
    expect(request).toEqual(expect.objectContaining({
      transcript_id: "T000001",
      segment_ids: ["seg_1", "seg_2"],
      segment_ranges: selection.segmentRanges,
      selected_text: "Alpha Gamma",
      new_codes: [{
        client_id: expect.stringMatching(/^draft-code-/),
        name: "Emergent code",
        color: "#123456",
        description: "Full definition",
        inclusion_note: "Include this",
        exclusion_note: "Exclude that",
        example_evidence_ids: ["E000001"],
        memo: "Code note",
        use_current_evidence_as_example: true
      }],
      ai_decisions: [acceptedDecision]
    }));
    expect(request.new_codes).toHaveLength(1);
    await act(async () => { pendingResponse.resolve(response); expect(await saving).toBe(true); });
  });

  it("creates evidence from an immutable snapshot and selects the authoritative response", async () => {
    const { result } = renderWorkspace();
    act(() => result.current.workspace.captureSelection(selection));
    act(() => result.current.workspace.updateInspectorMemo("Draft note"));
    apiMocks.createEvidence.mockImplementationOnce(async (request) => nextEvidencePayload(request));
    await act(async () => expect(await result.current.workspace.saveEvidenceDraft()).toBe(true));
    expect(apiMocks.createEvidence).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.any(Object),
      handle: expect.objectContaining({ revision: "a".repeat(64) }),
      memo: "Draft note"
    }));
    expect(result.current.workspace.selectedEvidenceId).toBe("E000002");
    expect(result.current.workspace.evidenceDraft).toBeNull();
    expect(result.current.workspace.evidenceEditDraft).toEqual(expect.objectContaining({ evidenceId: "E000002" }));
  });

  it("updates evidence from an immutable snapshot and refreshes from the authoritative response", async () => {
    const pendingSettings = deferred<Persisted>();
    const harness = renderWorkspace({ persist: { current: () => pendingSettings.promise } });
    act(() => {
      harness.result.current.workspace.selectEvidence(makeEvidence());
      harness.result.current.workspace.updateInspectorMemo("Captured note");
      harness.result.current.workspace.toggleInspectorCode("C000002");
    });
    let saving!: Promise<boolean>;
    act(() => { saving = harness.result.current.workspace.saveSelectedEvidence(); });
    act(() => harness.result.current.workspace.updateInspectorMemo("Late note"));
    apiMocks.updateEvidence.mockImplementationOnce(async (request) => nextEvidencePayload(request));
    await act(async () => { pendingSettings.resolve(persisted()); expect(await saving).toBe(true); });
    expect(apiMocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidence_id: "E000001",
      memo: "Captured note",
      code_ids: ["C000001", "C000002"]
    }));
    expect(harness.result.current.workspace.evidenceEditDraft).toEqual(expect.objectContaining({
      evidenceId: "E000001",
      memo: "Captured note"
    }));
  });

  it("removing one provisional code removes only its own decisions", () => {
    const { result } = renderWorkspace();
    const otherDecision = { ...acceptedDecision, suggestion_id: "suggestion_2" };
    let firstId = "";
    act(() => result.current.workspace.captureSelection(selection));
    act(() => expect(result.current.workspace.stageExistingCode("C000002", otherDecision)).toBe(true));
    act(() => { firstId = result.current.workspace.addInspectorCode(codeDialogValue()); });
    act(() => {
      result.current.workspace.addInspectorCode(codeDialogValue({
        name: "Other code",
        aiDecisions: [{ ...acceptedDecision, suggestion_id: "suggestion_3" }]
      }));
    });
    act(() => result.current.workspace.removeInspectorCode(firstId));
    expect(result.current.workspace.evidenceDraft?.newCodes.map((code) => code.name)).toEqual(["Other code"]);
    expect(result.current.workspace.evidenceDraft?.aiDecisions.map((item) => item.suggestion_id)).toEqual([
      "suggestion_2",
      "suggestion_3"
    ]);
  });

  it("blocks duplicate same-render saves with its synchronous lock", async () => {
    const { result } = renderWorkspace();
    const pending = deferred<unknown>();
    act(() => result.current.workspace.captureSelection(selection));
    apiMocks.createEvidence.mockReturnValueOnce(pending.promise);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.workspace.saveEvidenceDraft();
      second = result.current.workspace.saveEvidenceDraft();
      expect(result.current.workspace.captureSelection({
        transcriptId: transcriptOne.transcript_id,
        segmentIds: ["seg_2"],
        selectedText: "delta",
        segmentRanges: { seg_2: { start_offset: 6, end_offset: 11, excerpt: "delta" } }
      })).toBe(false);
      expect(result.current.workspace.selectEvidence(makeEvidence())).toBe(false);
    });
    expect(await second).toBe(false);
    await act(async () => { await Promise.resolve(); });
    const response = nextEvidencePayload(apiMocks.createEvidence.mock.calls[0][0]);
    await act(async () => { pending.resolve(response); expect(await first).toBe(true); });
    expect(apiMocks.createEvidence).toHaveBeenCalledTimes(1);
  });

  it("retains the complete draft when an external lock blocks persistence", async () => {
    const external = { current: false };
    const { result } = renderWorkspace({ externallyLocked: external });
    act(() => result.current.workspace.captureSelection(selection));
    act(() => result.current.workspace.updateInspectorMemo("Retained"));
    external.current = true;
    act(() => {
      expect(result.current.workspace.captureSelection({
        transcriptId: transcriptOne.transcript_id,
        segmentIds: ["seg_2"],
        selectedText: "delta",
        segmentRanges: { seg_2: { start_offset: 6, end_offset: 11, excerpt: "delta" } }
      })).toBe(false);
      expect(result.current.workspace.selectTranscript(transcriptTwo.transcript_id)).toBe(false);
      result.current.workspace.updateInspectorMemo("Blocked replacement");
      expect(result.current.workspace.stageExistingCode("C000002", acceptedDecision)).toBe(false);
      expect(result.current.workspace.applyAiNote("Blocked AI note", "use", acceptedDecision)).toBe(false);
      expect(result.current.workspace.addInspectorCode(codeDialogValue())).toBe("");
    });
    await act(async () => expect(await result.current.workspace.saveEvidenceDraft()).toBe(false));
    expect(result.current.workspace.evidenceDraft?.memo).toBe("Retained");
    expect(result.current.workspace.evidenceDraft?.codeIds).toEqual([]);
    expect(result.current.workspace.evidenceDraft?.newCodes).toEqual([]);
    expect(result.current.workspace.evidenceDraft?.aiDecisions).toEqual([]);
    expect(result.current.workspace.evidenceDraft?.selectedText).toBe("Alpha Gamma");
    expect(result.current.workspace.activeTranscriptId).not.toBe(transcriptTwo.transcript_id);
    expect(apiMocks.createEvidence).not.toHaveBeenCalled();
    expect(result.current.workspace.isLocked()).toBe(true);
  });

  it("reports local AI staging success only for a current valid draft mutation", () => {
    const { result } = renderWorkspace();
    expect(result.current.workspace.stageExistingCode("C000002", acceptedDecision)).toBe(false);
    expect(result.current.workspace.applyAiNote("AI note", "use", acceptedDecision)).toBe(false);
    expect(result.current.workspace.addInspectorCode(codeDialogValue())).toBe("");

    act(() => result.current.workspace.captureSelection(selection));
    act(() => expect(result.current.workspace.stageExistingCode("missing-code", acceptedDecision)).toBe(false));
    expect(result.current.workspace.evidenceDraft?.aiDecisions).toEqual([]);
    act(() => expect(result.current.workspace.stageExistingCode("C000002", acceptedDecision)).toBe(true));
    act(() => expect(result.current.workspace.applyAiNote("AI note", "use", { ...acceptedDecision, suggestion_id: "note_1" })).toBe(true));
    expect(result.current.workspace.evidenceDraft).toEqual(expect.objectContaining({
      codeIds: ["C000002"],
      memo: "AI note",
      aiDecisions: [acceptedDecision, { ...acceptedDecision, suggestion_id: "note_1" }]
    }));
    act(() => expect(result.current.workspace.stageExistingCode("C000002", acceptedDecision)).toBe(false));
    act(() => expect(result.current.workspace.applyAiNote("AI note", "replace", acceptedDecision)).toBe(false));
    expect(result.current.workspace.evidenceDraft?.aiDecisions).toHaveLength(2);
  });

  it("serializes same-batch local draft mutations through authoritative refs", () => {
    const { result } = renderWorkspace();
    const noteDecision = { ...acceptedDecision, suggestion_id: "batch_note", task: "note" as const };
    const codeDecision = { ...acceptedDecision, suggestion_id: "batch_code" };
    const aiCode = codeDialogValue({ name: "AI batch code", aiDecisions: [codeDecision] });
    let firstStage = false;
    let secondStage = false;
    let firstNote = false;
    let secondNote = false;
    let firstCodeId = "";
    let secondCodeId = "";
    let manualCodeId = "";

    act(() => result.current.workspace.captureSelection(selection));
    act(() => {
      firstStage = result.current.workspace.stageExistingCode("C000002", acceptedDecision);
      secondStage = result.current.workspace.stageExistingCode("C000002", acceptedDecision);
      firstNote = result.current.workspace.applyAiNote("Batch note", "use", noteDecision);
      secondNote = result.current.workspace.applyAiNote("Batch note", "replace", noteDecision);
      firstCodeId = result.current.workspace.addInspectorCode(aiCode);
      secondCodeId = result.current.workspace.addInspectorCode(aiCode);
      manualCodeId = result.current.workspace.addInspectorCode(codeDialogValue({
        name: "AI batch code",
        aiDecisions: []
      }));
    });

    expect(firstStage).toBe(true);
    expect(secondStage).toBe(false);
    expect(firstNote).toBe(true);
    expect(secondNote).toBe(false);
    expect(firstCodeId).toMatch(/^draft-code-/);
    expect(secondCodeId).toBe("");
    expect(manualCodeId).toMatch(/^draft-code-/);
    expect(result.current.workspace.evidenceDraft).toEqual(expect.objectContaining({
      codeIds: ["C000002"],
      memo: "Batch note"
    }));
    expect(result.current.workspace.evidenceDraft?.newCodes).toHaveLength(2);
    expect(result.current.workspace.evidenceDraft?.aiDecisions.map((item) => item.suggestion_id)).toEqual([
      "suggestion_1",
      "batch_note",
      "batch_code"
    ]);
  });

  it("retains a current failed draft and forwards a current conflict", async () => {
    const { result, conflicts, errors } = renderWorkspace();
    act(() => {
      result.current.workspace.selectEvidence(makeEvidence());
      result.current.workspace.updateInspectorMemo("Retry me");
    });
    const conflict = new CodesProjectConflictError(
      new ApiError({ message: "Project changed elsewhere.", kind: "http", status: 409 }),
      "b".repeat(64)
    );
    apiMocks.updateEvidence.mockRejectedValueOnce(conflict);
    await act(async () => expect(await result.current.workspace.saveSelectedEvidence()).toBe(false));
    expect(conflicts).toEqual([conflict]);
    expect(errors).toEqual([{ error: conflict, fallback: "Evidence changes could not be saved." }]);
    expect(result.current.workspace.evidenceEditDraft?.memo).toBe("Retry me");
    expect(result.current.workspace.evidenceError).toBe("Project changed elsewhere.");
  });

  it.each(["success", "failure", "conflict"])("suppresses a stale %s after reset", async (outcome) => {
    const { result, errors, conflicts, statuses } = renderWorkspace();
    const pending = deferred<unknown>();
    act(() => result.current.workspace.captureSelection(selection));
    statuses.length = 0;
    apiMocks.createEvidence.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveEvidenceDraft(); });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.workspace.resetForClose());
    await act(async () => {
      if (outcome === "success") pending.resolve(nextEvidencePayload(apiMocks.createEvidence.mock.calls[0][0]));
      else if (outcome === "conflict") pending.reject(new CodesProjectConflictError(new ApiError({ message: "Stale conflict", kind: "http", status: 409 })));
      else pending.reject(new Error("Stale failure"));
      expect(await saving).toBe(false);
    });
    expect(errors).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(statuses).toEqual([]);
    expect(result.current.workspace.evidenceDraft).toBeNull();
  });

  it.each(["project", "file", "revision"])("suppresses stale success and failure after %s replacement", async (replacement) => {
    for (const outcome of ["success", "failure"] as const) {
      const { result, errors, statuses } = renderWorkspace();
      const pending = deferred<unknown>();
      act(() => result.current.workspace.captureSelection(selection));
      statuses.length = 0;
      apiMocks.createEvidence.mockReturnValueOnce(pending.promise);
      let saving!: Promise<boolean>;
      act(() => { saving = result.current.workspace.saveEvidenceDraft(); });
      await act(async () => { await Promise.resolve(); });
      const next = replacement === "project"
        ? persisted(makeProject({ project_id: "project_b" }), makeHandle("a", "project_b", "project_b"))
        : replacement === "file"
          ? persisted(makeProject(), makeHandle("a", "copy"))
          : persisted(makeProject(), makeHandle("b"));
      act(() => result.current.replaceSession(next));
      await act(async () => {
        if (outcome === "success") pending.resolve(nextEvidencePayload(apiMocks.createEvidence.mock.calls.at(-1)![0]));
        else pending.reject(new Error("Stale failure"));
        expect(await saving).toBe(false);
      });
      expect(errors).toEqual([]);
      expect(statuses).toEqual([]);
    }
  });

  it("suppresses a late failure after unmount", async () => {
    const { result, unmount, errors, busyChanges } = renderWorkspace();
    const pending = deferred<unknown>();
    act(() => result.current.workspace.captureSelection(selection));
    apiMocks.createEvidence.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveEvidenceDraft(); });
    await act(async () => { await Promise.resolve(); });
    unmount();
    await act(async () => { pending.reject(new Error("Unmounted failure")); expect(await saving).toBe(false); });
    expect(errors).toEqual([]);
    expect(busyChanges.at(-1)).toBe(false);
  });

  it("keeps transcript removal blocked while evidence refers to the transcript", async () => {
    const { result } = renderWorkspace();
    act(() => expect(result.current.workspace.openTranscriptRemoval(transcriptOne)).toBe(true));
    expect(result.current.workspace.transcriptActionDialog).toEqual(expect.objectContaining({ evidenceCount: 1 }));
    await act(async () => expect(await result.current.workspace.confirmTranscriptRemoval()).toBe(false));
    expect(apiMocks.removeTranscript).not.toHaveBeenCalled();
  });

  it("Show Evidence activates the transcript and clears search and code/theme filters", () => {
    const { result } = renderWorkspace();
    act(() => {
      result.current.workspace.selectTranscript(transcriptTwo.transcript_id);
      result.current.workspace.setEvidenceSearch("query");
      result.current.workspace.setEvidenceScope("all");
      result.current.workspace.setEvidenceFilterCodeId("C000001");
      result.current.workspace.setEvidenceFilterThemeId("TH000001");
    });
    act(() => result.current.workspace.openTranscriptRemoval(transcriptOne));
    act(() => result.current.workspace.showTranscriptEvidence());
    expect(result.current.workspace.activeTranscriptId).toBe(transcriptOne.transcript_id);
    expect(result.current.workspace.evidenceScope).toBe("active");
    expect(result.current.workspace.evidenceSearch).toBe("");
    expect(result.current.workspace.evidenceFilterCodeId).toBe("");
    expect(result.current.workspace.evidenceFilterThemeId).toBe("");
    expect(result.current.workspace.transcriptActionDialog).toBeNull();
  });

  it("removes an uncoded transcript and selects the authoritative next transcript", async () => {
    const initialProject = makeProject({ evidence_items: [] });
    const { result } = renderWorkspace({ initial: persisted(initialProject) });
    act(() => {
      result.current.workspace.resetForOpenProject(initialProject);
      result.current.workspace.selectTranscript(transcriptOne.transcript_id);
      result.current.workspace.openTranscriptRemoval(transcriptOne);
    });
    const nextProject = { ...initialProject, transcripts: [transcriptTwo] };
    const nextHandle = makeHandle("b");
    apiMocks.removeTranscript.mockResolvedValueOnce(mutationPayload(nextProject, nextHandle, {
      transcript_id: transcriptOne.transcript_id,
      label: transcriptOne.label
    }));
    await act(async () => expect(await result.current.workspace.confirmTranscriptRemoval()).toBe(true));
    expect(result.current.workspace.activeTranscriptId).toBe(transcriptTwo.transcript_id);
    expect(result.current.workspace.selectedEvidenceId).toBe("");
    expect(result.current.workspace.transcriptActionDialog).toBeNull();
  });

  it("retains the evidence deletion dialog and scoped error for a retry, then closes on success", async () => {
    const { result, statuses } = renderWorkspace();
    act(() => result.current.workspace.selectEvidence(makeEvidence()));
    act(() => result.current.workspace.updateInspectorMemo("Unsaved"));
    act(() => result.current.workspace.openEvidenceDelete());
    apiMocks.deleteEvidence.mockRejectedValueOnce(new Error("Deletion failed."));
    await act(async () => expect(await result.current.workspace.confirmEvidenceDelete()).toBe(false));
    expect(result.current.workspace.evidenceToDelete?.evidence_id).toBe("E000001");
    expect(result.current.workspace.deleteEvidenceError).toBe("Deletion failed.");
    const nextProject = makeProject({ evidence_items: [] });
    const nextHandle = makeHandle("b");
    apiMocks.deleteEvidence.mockResolvedValueOnce(mutationPayload(nextProject, nextHandle, { evidence_id: "E000001" }));
    await act(async () => expect(await result.current.workspace.confirmEvidenceDelete()).toBe(true));
    expect(result.current.workspace.evidenceToDelete).toBeNull();
    expect(result.current.workspace.selectedEvidenceId).toBe("");
    expect(statuses.at(-1)).toBe("Deleted evidence item E000001.");
  });

  it("retains selections, drafts, and filters across Save As and uses the new handle", async () => {
    const { result } = renderWorkspace();
    act(() => {
      result.current.workspace.selectEvidence(makeEvidence());
      result.current.workspace.updateInspectorMemo("Save As draft");
      result.current.workspace.setEvidenceSearch("keep");
      const savedAs = persisted(makeProject(), makeHandle("b", "copy"));
      result.current.replaceSession(savedAs);
      result.current.workspace.reconcileAfterSaveAs(savedAs.project);
    });
    const nextHandle = makeHandle("c", "copy");
    apiMocks.updateEvidence.mockImplementationOnce(async (request) => mutationPayload(
      { ...request.project, evidence_items: request.project.evidence_items.map((item: CodesEvidenceItem) => item.evidence_id === "E000001" ? { ...item, memo: request.memo } : item) },
      nextHandle,
      { evidence: { ...makeEvidence(), memo: request.memo } }
    ));
    await act(async () => expect(await result.current.workspace.saveSelectedEvidence()).toBe(true));
    expect(apiMocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ project_file: makeHandle("b", "copy").project_file, revision: "b".repeat(64) })
    }));
    expect(result.current.workspace.evidenceSearch).toBe("keep");
  });

  it("applies New, Open, Reload, and Close reset semantics explicitly", () => {
    const { result } = renderWorkspace();
    act(() => {
      result.current.workspace.resetForOpenProject(makeProject());
      result.current.workspace.selectEvidence(makeEvidence());
      result.current.workspace.setEvidenceSearch("search");
      result.current.workspace.openEvidenceDelete();
      result.current.workspace.resetForReload(makeProject());
    });
    expect(result.current.workspace.selectedEvidenceId).toBe("E000001");
    expect(result.current.workspace.evidenceEditDraft).toEqual(expect.objectContaining({ evidenceId: "E000001" }));
    expect(result.current.workspace.evidenceToDelete).toBeNull();
    expect(result.current.workspace.evidenceSearch).toBe("search");
    act(() => result.current.workspace.resetForNewProject());
    expect(result.current.workspace.activeTranscriptId).toBe("");
    expect(result.current.workspace.selectedEvidenceId).toBe("");
    expect(result.current.workspace.evidenceSearch).toBe("");
    act(() => result.current.workspace.resetForClose());
    expect(result.current.workspace.evidenceDraft).toBeNull();
  });

  it("reconciles imports without discarding valid selection and selects the first import when previously empty", () => {
    const initial = makeProject({ transcripts: [], evidence_items: [] });
    const { result } = renderWorkspace({ initial: persisted(initial) });
    const imported = { ...initial, transcripts: [transcriptTwo] };
    act(() => result.current.workspace.reconcileAfterImport(imported, { imported: [transcriptTwo] }));
    expect(result.current.workspace.activeTranscriptId).toBe(transcriptTwo.transcript_id);
    const withBoth = makeProject();
    act(() => {
      result.current.workspace.selectTranscript(transcriptTwo.transcript_id);
      result.current.workspace.reconcileAfterImport(withBoth, { imported: [transcriptOne] });
    });
    expect(result.current.workspace.activeTranscriptId).toBe(transcriptTwo.transcript_id);
  });

  it("removes a deleted code from new and existing drafts without touching unrelated assignments", () => {
    const { result } = renderWorkspace();
    act(() => result.current.workspace.captureSelection(selection));
    act(() => result.current.workspace.toggleInspectorCode("C000001"));
    act(() => result.current.workspace.toggleInspectorCode("C000002"));
    act(() => result.current.workspace.removeDeletedCode("C000001"));
    expect(result.current.workspace.evidenceDraft?.codeIds).toEqual(["C000002"]);
    const assignedEvidence = makeEvidence({ code_ids: ["C000001", "C000002"] });
    act(() => result.current.replaceSession(persisted(makeProject({ evidence_items: [assignedEvidence] }))));
    act(() => result.current.workspace.selectEvidence(assignedEvidence));
    act(() => result.current.workspace.removeDeletedCode("C000001"));
    expect(result.current.workspace.evidenceEditDraft?.codeIds).toEqual(["C000002"]);
  });
});

describe("Codes evidence deletion dialog", () => {
  it("identifies the evidence, warns about unsaved changes, and exposes accessible Delete and Cancel actions", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(
      <CodesEvidenceDeleteDialog
        evidence={makeEvidence({ selected_text: "A short visible excerpt" })}
        hasUnsavedChanges
        busy={false}
        error={null}
        onConfirm={onDelete}
        onClose={onClose}
      />
    );
    const dialog = screen.getByRole("alertdialog", { name: "Delete Evidence" });
    expect(dialog).toHaveTextContent("E000001");
    expect(dialog).toHaveTextContent("A short visible excerpt");
    expect(dialog).toHaveTextContent(/unsaved inspector changes/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("locks both actions and retains a current failure while deletion is active", () => {
    render(
      <CodesEvidenceDeleteDialog
        evidence={makeEvidence()}
        hasUnsavedChanges={false}
        busy
        error="Deletion failed safely."
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Deletion failed safely.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  });

  it("keeps Cancel available while an external workflow locks evidence deletion", () => {
    render(
      <CodesEvidenceDeleteDialog
        evidence={makeEvidence()}
        hasUnsavedChanges={false}
        busy={false}
        mutationLocked
        error={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("Codes transcript removal dialog", () => {
  it("keeps Cancel available while an external workflow locks transcript removal", () => {
    render(
      <CodesTranscriptActionDialog
        state={{ kind: "remove", transcript: transcriptOne, evidenceCount: 0 }}
        busy={false}
        mutationLocked
        onConfirmRemove={vi.fn()}
        onShowEvidence={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Remove Transcript" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
