import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodesProject,
  CodesProjectHandle,
  TranscriptImportCandidate,
  TranscriptImportPreview,
  TranscriptImportResult
} from "../../src/lib/api";
import { useCodesTranscriptImport } from "../../src/hooks/useCodesTranscriptImport";
import type { CodesProjectSessionSnapshot } from "../../src/hooks/useCodesProjectSession";

const apiMocks = vi.hoisted(() => ({
  pickFile: vi.fn(),
  pickFolder: vi.fn(),
  previewImport: vi.fn(),
  importCandidates: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    pickTranscriptFile: apiMocks.pickFile,
    pickFolder: apiMocks.pickFolder,
    previewCodesTranscriptImport: apiMocks.previewImport,
    importCodesTranscriptCandidates: apiMocks.importCandidates
  };
});

const project: CodesProject = {
  schema_version: "1.1",
  project_id: "project_test",
  name: "Import Study",
  created_at: "2026-08-05T10:00:00Z",
  updated_at: "2026-08-05T10:00:00Z",
  research_focus: "",
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
  project_file: "D:\\research\\study.evidence.json",
  project_id: project.project_id,
  revision: "a".repeat(64)
};

function candidate(
  candidateId: string,
  status: TranscriptImportCandidate["status"] = "ready",
  preferred = status === "ready"
): TranscriptImportCandidate {
  return {
    candidate_id: candidateId,
    source_path: `D:\\research\\${candidateId}.json`,
    source_document_id: `document_${candidateId}`,
    document_index: 0,
    format: "json",
    logical_fingerprint: `fingerprint_${candidateId}`,
    logical_group: `group_${candidateId}`,
    title: candidateId,
    segment_count: 2,
    status,
    preferred,
    reason: ""
  };
}

function preview(
  candidates: TranscriptImportCandidate[],
  overrides: Partial<TranscriptImportPreview> = {}
): TranscriptImportPreview {
  return {
    ...handle,
    candidates,
    counts: {
      ready: candidates.filter((item) => item.status === "ready").length,
      already_imported: candidates.filter((item) => item.status === "already_imported").length,
      alternate_format: candidates.filter((item) => item.status === "alternate_format").length,
      problem: candidates.filter((item) => item.status === "problem").length
    },
    non_recursive: true,
    ...overrides
  };
}

function importResult(
  nextProject: CodesProject = project,
  nextHandle: CodesProjectHandle = { ...handle, revision: "b".repeat(64) }
): TranscriptImportResult {
  return {
    ...nextHandle,
    project: nextProject,
    handle: nextHandle,
    imported: [],
    skipped: [],
    failed: []
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

function session(
  activeProject: CodesProject | null = project,
  activeHandle: CodesProjectHandle | null = handle
): CodesProjectSessionSnapshot {
  return {
    project: activeProject,
    projectFile: activeHandle?.project_file ?? null,
    projectHandle: activeHandle,
    projectConflict: null,
    settingsDirty: false
  };
}

function renderImportHook() {
  let currentSession = session();
  const applyPersistedProject = vi.fn((payload: { project: CodesProject; handle: CodesProjectHandle }) => {
    currentSession = session(payload.project, payload.handle);
    return true;
  });
  const persistProjectSettings = vi.fn(async () => {
    if (!currentSession.project || !currentSession.projectHandle) return null;
    return { project: currentSession.project, handle: currentSession.projectHandle };
  });
  const onOperationStarted = vi.fn();
  const onPreviewReady = vi.fn();
  const onImportApplied = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useCodesTranscriptImport({
    desktopAvailable: true,
    getCurrentSession: () => currentSession,
    applyPersistedProject,
    persistProjectSettings,
    onOperationStarted,
    onPreviewReady,
    onImportApplied,
    onError
  }));

  return {
    ...hook,
    applyPersistedProject,
    persistProjectSettings,
    onOperationStarted,
    onPreviewReady,
    onImportApplied,
    onError,
    replaceSession(nextSession: CodesProjectSessionSnapshot) {
      currentSession = nextSession;
    }
  };
}

async function openFilePreview(
  hook: ReturnType<typeof renderImportHook>,
  nextPreview: TranscriptImportPreview
) {
  apiMocks.pickFile.mockResolvedValueOnce("D:\\research\\transcript.json");
  apiMocks.previewImport.mockResolvedValueOnce(nextPreview);
  await act(async () => {
    await hook.result.current.chooseFile();
  });
}

describe("useCodesTranscriptImport", () => {
  beforeEach(() => {
    apiMocks.pickFile.mockReset();
    apiMocks.pickFolder.mockReset();
    apiMocks.previewImport.mockReset();
    apiMocks.importCandidates.mockReset();
  });

  it("does not preview when the file picker is cancelled", async () => {
    const hook = renderImportHook();
    apiMocks.pickFile.mockResolvedValueOnce(null);

    await act(async () => {
      await hook.result.current.chooseFile();
    });

    expect(apiMocks.previewImport).not.toHaveBeenCalled();
    expect(hook.result.current.busy).toBe(false);
  });

  it("does not preview when the folder picker is cancelled", async () => {
    const hook = renderImportHook();
    apiMocks.pickFolder.mockResolvedValueOnce(null);

    await act(async () => {
      await hook.result.current.chooseFolder();
    });

    expect(apiMocks.previewImport).not.toHaveBeenCalled();
    expect(hook.result.current.busy).toBe(false);
  });

  it("initially selects only preferred ready candidates", async () => {
    const hook = renderImportHook();
    const readyPreferred = candidate("ready_preferred");
    const readySecondary = candidate("ready_secondary", "ready", false);
    const alternate = candidate("alternate", "alternate_format", true);

    await openFilePreview(hook, preview([readyPreferred, readySecondary, alternate]));

    expect(hook.result.current.selectedCandidateIds).toEqual([readyPreferred.candidate_id]);
  });

  it("toggles ready and alternate candidates but rejects nonselectable candidates", async () => {
    const hook = renderImportHook();
    const ready = candidate("ready", "ready", false);
    const alternate = candidate("alternate", "alternate_format", false);
    const duplicate = candidate("duplicate", "already_imported", false);
    const problem = candidate("problem", "problem", false);
    await openFilePreview(hook, preview([ready, alternate, duplicate, problem]));

    act(() => {
      hook.result.current.toggleCandidate(ready);
      hook.result.current.toggleCandidate(alternate);
      hook.result.current.toggleCandidate(duplicate);
      hook.result.current.toggleCandidate(problem);
    });

    expect(hook.result.current.selectedCandidateIds).toEqual(["ready", "alternate"]);
  });

  it("confirms the immutable candidate selection captured from the visible preview", async () => {
    const hook = renderImportHook();
    const first = candidate("first");
    const second = candidate("second", "ready", false);
    await openFilePreview(hook, preview([first, second]));
    act(() => hook.result.current.toggleCandidate(second));
    const pendingImport = deferred<TranscriptImportResult>();
    apiMocks.importCandidates.mockReturnValueOnce(pendingImport.promise);

    let confirmation!: Promise<void>;
    act(() => {
      confirmation = hook.result.current.confirmImport();
    });
    await waitFor(() => expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.toggleCandidate(first));

    expect(apiMocks.importCandidates.mock.calls[0][0].candidates.map(
      (item: { candidate_id: string }) => item.candidate_id
    )).toEqual(["first", "second"]);

    await act(async () => {
      pendingImport.resolve(importResult());
      await confirmation;
    });
  });

  it("submits alternate formats with duplicate permission", async () => {
    const hook = renderImportHook();
    const alternate = candidate("alternate", "alternate_format", false);
    await openFilePreview(hook, preview([alternate]));
    act(() => hook.result.current.toggleCandidate(alternate));
    apiMocks.importCandidates.mockResolvedValueOnce(importResult());

    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(apiMocks.importCandidates).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ candidate_id: "alternate", allow_duplicate: true })]
    }));
  });

  it("applies a successful import project and handle exactly once", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const payload = importResult();
    apiMocks.importCandidates.mockResolvedValueOnce(payload);

    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(1);
    expect(hook.applyPersistedProject).toHaveBeenCalledWith({
      project: payload.project,
      handle: payload.handle
    });
    expect(hook.onImportApplied).toHaveBeenCalledTimes(1);
  });

  it("confirms a retained preview against the current Save As file and revision", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const savedAsHandle = {
      ...handle,
      project_file: "D:\\research\\study-copy.evidence.json",
      revision: "c".repeat(64)
    };
    const importedHandle = { ...savedAsHandle, revision: "d".repeat(64) };
    const payload = importResult(project, importedHandle);

    act(() => {
      hook.replaceSession(session(project, savedAsHandle));
    });
    apiMocks.importCandidates.mockResolvedValueOnce(payload);

    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(apiMocks.importCandidates).toHaveBeenCalledWith(expect.objectContaining({
      project,
      handle: savedAsHandle
    }));
    expect(hook.applyPersistedProject).toHaveBeenCalledWith({
      project: payload.project,
      handle: payload.handle
    });
    expect(hook.onImportApplied).toHaveBeenCalledTimes(1);
    expect(hook.result.current.preview).toBeNull();
  });

  it("does not confirm a visible preview for a different logical project", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const replacementProject = { ...project, project_id: "replacement" };
    const replacementHandle = {
      ...handle,
      project_id: replacementProject.project_id,
      project_file: "D:\\research\\replacement.evidence.json"
    };

    act(() => {
      hook.replaceSession(session(replacementProject, replacementHandle));
    });
    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(hook.persistProjectSettings).not.toHaveBeenCalled();
    expect(apiMocks.importCandidates).not.toHaveBeenCalled();
  });

  it("clears preview and selection while retaining the successful result summary", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const payload = importResult();
    apiMocks.importCandidates.mockResolvedValueOnce(payload);

    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.selectedCandidateIds).toEqual([]);
    expect(hook.result.current.result).toEqual({
      imported: payload.imported,
      skipped: payload.skipped,
      failed: payload.failed
    });
  });

  it("keeps preview and selection available when confirmation fails", async () => {
    const hook = renderImportHook();
    const visiblePreview = preview([candidate("ready")]);
    await openFilePreview(hook, visiblePreview);
    apiMocks.importCandidates.mockRejectedValueOnce(new Error("failed"));

    await act(async () => {
      await hook.result.current.confirmImport();
    });

    expect(hook.result.current.preview).toBe(visiblePreview);
    expect(hook.result.current.selectedCandidateIds).toEqual(["ready"]);
    expect(hook.onError).toHaveBeenCalledWith(expect.any(Error), "Transcripts could not be imported.");
  });

  it("publishes only the newest of overlapping previews", async () => {
    const hook = renderImportHook();
    const firstRequest = deferred<TranscriptImportPreview>();
    const secondRequest = deferred<TranscriptImportPreview>();
    const firstPreview = preview([candidate("first")]);
    const secondPreview = preview([candidate("second")]);
    apiMocks.pickFile.mockResolvedValueOnce("D:\\research\\first.json");
    apiMocks.pickFolder.mockResolvedValueOnce("D:\\research\\second");
    apiMocks.previewImport
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    let firstOperation!: Promise<void>;
    act(() => {
      firstOperation = hook.result.current.chooseFile();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(1));
    let secondOperation!: Promise<void>;
    act(() => {
      secondOperation = hook.result.current.chooseFolder();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondRequest.resolve(secondPreview);
      await secondOperation;
    });
    await act(async () => {
      firstRequest.resolve(firstPreview);
      await firstOperation;
    });

    expect(hook.result.current.preview).toBe(secondPreview);
    expect(hook.result.current.selectedCandidateIds).toEqual(["second"]);
  });

  it("does not publish an error from a stale preview request", async () => {
    const hook = renderImportHook();
    const staleRequest = deferred<TranscriptImportPreview>();
    const currentRequest = deferred<TranscriptImportPreview>();
    apiMocks.pickFile.mockResolvedValueOnce("D:\\research\\old.json");
    apiMocks.pickFolder.mockResolvedValueOnce("D:\\research\\new");
    apiMocks.previewImport
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);

    let staleOperation!: Promise<void>;
    act(() => {
      staleOperation = hook.result.current.chooseFile();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(1));
    let currentOperation!: Promise<void>;
    act(() => {
      currentOperation = hook.result.current.chooseFolder();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(2));

    await act(async () => {
      currentRequest.resolve(preview([candidate("current")]));
      await currentOperation;
    });
    await act(async () => {
      staleRequest.reject(new Error("obsolete"));
      await staleOperation;
    });

    expect(hook.onError).not.toHaveBeenCalled();
    expect(hook.result.current.preview?.candidates[0].candidate_id).toBe("current");
  });

  it("invalidates a pending preview when reset replaces the project session", async () => {
    const hook = renderImportHook();
    const pendingPreview = deferred<TranscriptImportPreview>();
    apiMocks.pickFile.mockResolvedValueOnce("D:\\research\\old.json");
    apiMocks.previewImport.mockReturnValueOnce(pendingPreview.promise);
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.chooseFile();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(1));

    act(() => {
      hook.replaceSession(session(
        { ...project, project_id: "replacement" },
        { ...handle, project_id: "replacement", project_file: "D:\\research\\replacement.evidence.json" }
      ));
      hook.result.current.reset();
    });
    await act(async () => {
      pendingPreview.resolve(preview([candidate("stale")]));
      await operation;
    });

    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.busy).toBe(false);
  });

  it("ignores a picker result that arrives after reset", async () => {
    const hook = renderImportHook();
    const pendingPicker = deferred<string | null>();
    apiMocks.pickFile.mockReturnValueOnce(pendingPicker.promise);

    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.chooseFile();
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));

    act(() => {
      hook.result.current.reset();
    });
    await act(async () => {
      pendingPicker.resolve("D:\\research\\stale.json");
      await operation;
    });

    expect(apiMocks.previewImport).not.toHaveBeenCalled();
    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.busy).toBe(false);
  });

  it("ignores confirmation results from a replaced project session", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const pendingImport = deferred<TranscriptImportResult>();
    apiMocks.importCandidates.mockReturnValueOnce(pendingImport.promise);
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.confirmImport();
    });
    await waitFor(() => expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1));

    act(() => {
      hook.replaceSession(session(
        { ...project, project_id: "replacement" },
        { ...handle, project_id: "replacement", project_file: "D:\\research\\replacement.evidence.json" }
      ));
    });
    await act(async () => {
      pendingImport.resolve(importResult());
      await operation;
    });

    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.onImportApplied).not.toHaveBeenCalled();
  });

  it("does not publish a rejected confirmation after project replacement", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const pendingImport = deferred<TranscriptImportResult>();
    apiMocks.importCandidates.mockReturnValueOnce(pendingImport.promise);
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.confirmImport();
    });
    await waitFor(() => expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1));

    act(() => {
      hook.replaceSession(session(
        { ...project, project_id: "replacement" },
        { ...handle, project_id: "replacement", project_file: "D:\\research\\replacement.evidence.json" }
      ));
    });
    await act(async () => {
      pendingImport.reject(new Error("obsolete"));
      await operation;
    });

    expect(hook.onError).not.toHaveBeenCalled();
  });

  it("does not publish a rejected confirmation after reset", async () => {
    const hook = renderImportHook();
    await openFilePreview(hook, preview([candidate("ready")]));
    const pendingImport = deferred<TranscriptImportResult>();
    apiMocks.importCandidates.mockReturnValueOnce(pendingImport.promise);
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.confirmImport();
    });
    await waitFor(() => expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1));

    act(() => {
      hook.result.current.reset();
    });
    await act(async () => {
      pendingImport.reject(new Error("obsolete"));
      await operation;
    });

    expect(hook.onError).not.toHaveBeenCalled();
    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.busy).toBe(false);
  });

  it("does not let an older request clear the busy state of a newer request", async () => {
    const hook = renderImportHook();
    const firstRequest = deferred<TranscriptImportPreview>();
    const secondRequest = deferred<TranscriptImportPreview>();
    apiMocks.pickFile.mockResolvedValueOnce("D:\\research\\first.json");
    apiMocks.pickFolder.mockResolvedValueOnce("D:\\research\\second");
    apiMocks.previewImport
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    let firstOperation!: Promise<void>;
    act(() => {
      firstOperation = hook.result.current.chooseFile();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(1));
    let secondOperation!: Promise<void>;
    act(() => {
      secondOperation = hook.result.current.chooseFolder();
    });
    await waitFor(() => expect(apiMocks.previewImport).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstRequest.resolve(preview([candidate("first")]));
      await firstOperation;
    });
    expect(hook.result.current.busy).toBe(true);

    await act(async () => {
      secondRequest.resolve(preview([candidate("second")]));
      await secondOperation;
    });
    expect(hook.result.current.busy).toBe(false);
  });
});
