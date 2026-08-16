import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodesProjectFileLifecycle } from "../../src/hooks/useCodesProjectFileLifecycle";
import type {
  CodesProject,
  CodesProjectHandle,
  CodesProjectPayload
} from "../../src/lib/api";
import type { CodesProjectSessionSnapshot } from "../../src/hooks/useCodesProjectSession";

const apiMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
  pickOpen: vi.fn(),
  pickSave: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    createCodesProject: apiMocks.createProject,
    loadCodesProject: apiMocks.loadProject,
    saveCodesProject: apiMocks.saveProject,
    pickEvidenceProjectFile: apiMocks.pickOpen,
    pickEvidenceProjectSaveFile: apiMocks.pickSave
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

function makeProject(projectId = "project_a", name = "Study"): CodesProject {
  return {
    schema_version: "1.1",
    project_id: projectId,
    name,
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
}

function makeHandle(projectId = "project_a", revision = "a", file = projectId): CodesProjectHandle {
  return {
    project_file: `D:\\research\\${file}.evidence.json`,
    project_id: projectId,
    revision: revision.repeat(64)
  };
}

function payload(project = makeProject(), handle = makeHandle()): CodesProjectPayload {
  return { ...handle, project, handle };
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function renderLifecycle(initial: CodesProjectPayload | null = null, strict = false) {
  let session: CodesProjectSessionSnapshot = initial
    ? {
        project: initial.project,
        projectFile: initial.handle.project_file,
        projectHandle: initial.handle,
        projectConflict: null,
        settingsDirty: false
      }
    : {
        project: null,
        projectFile: null,
        projectHandle: null,
        projectConflict: null,
        settingsDirty: false
      };
  let externallyLocked = false;
  const actions = {
    activateProjectSession: vi.fn((next: { project: CodesProject; handle: CodesProjectHandle }) => {
      session = {
        project: next.project,
        projectFile: next.handle.project_file,
        projectHandle: next.handle,
        projectConflict: null,
        settingsDirty: false
      };
    }),
    clearProjectSession: vi.fn(() => {
      session = { project: null, projectFile: null, projectHandle: null, projectConflict: null, settingsDirty: false };
    }),
    resetAiDecisions: vi.fn(),
    invalidateDraftGuard: vi.fn(),
    resetEvidenceForNewProject: vi.fn(),
    resetEvidenceForOpenProject: vi.fn(),
    resetEvidenceForReload: vi.fn(),
    resetEvidenceForClose: vi.fn(),
    reconcileEvidenceAfterSaveAs: vi.fn(),
    resetCodebook: vi.fn(),
    resetTranscriptImport: vi.fn(),
    showEvidenceWorkspace: vi.fn(),
    onOperationStarted: vi.fn(),
    onStatusMessage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn()
  };
  const hook = renderHook(() => useCodesProjectFileLifecycle({
    desktopAvailable: true,
    getCurrentSession: () => session,
    isExternallyLocked: () => externallyLocked,
    ...actions
  }), strict ? { wrapper: StrictModeWrapper } : undefined);
  return {
    ...hook,
    actions,
    getSession: () => session,
    replaceSession(next: CodesProjectPayload | null) {
      session = next
        ? { project: next.project, projectFile: next.handle.project_file, projectHandle: next.handle, projectConflict: null, settingsDirty: false }
        : { project: null, projectFile: null, projectHandle: null, projectConflict: null, settingsDirty: false };
    },
    setSession(next: CodesProjectSessionSnapshot) { session = next; },
    setExternallyLocked(value: boolean) { externallyLocked = value; }
  };
}

describe("Codes project file lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.pickOpen.mockResolvedValue("D:\\research\\opened.evidence.json");
    apiMocks.pickSave.mockResolvedValue("D:\\research\\saved.evidence.json");
    apiMocks.createProject.mockResolvedValue(payload());
    apiMocks.loadProject.mockResolvedValue(payload());
    apiMocks.saveProject.mockImplementation(async (_file, project) => payload(project, makeHandle(project.project_id, "b", "saved")));
  });

  it.each(["newProject", "openProject", "saveAs"] as const)("silently releases a cancelled %s picker", async (operation) => {
    const initial = operation === "saveAs" ? payload() : null;
    const { result, actions } = renderLifecycle(initial);
    if (operation === "openProject") apiMocks.pickOpen.mockResolvedValue(null);
    else apiMocks.pickSave.mockResolvedValue(null);
    await act(async () => { expect(await result.current[operation]()).toBe(false); });
    expect(result.current.isLocked()).toBe(false);
    expect(actions.onError).not.toHaveBeenCalled();
    expect(actions.onStatusMessage).not.toHaveBeenCalled();
  });

  it("locks synchronously before New Project picker resolution and performs exact resets", async () => {
    const picker = deferred<string | null>();
    apiMocks.pickSave.mockReturnValue(picker.promise);
    const created = payload(makeProject("project_new", "new_study"), makeHandle("project_new", "b", "new_study"));
    apiMocks.createProject.mockResolvedValue(created);
    const { result, actions } = renderLifecycle();
    let request!: Promise<boolean>;
    act(() => { request = result.current.newProject(); });
    expect(result.current.isLocked()).toBe(true);
    expect(apiMocks.pickSave).toHaveBeenCalledOnce();
    await act(async () => {
      picker.resolve("D:\\research\\new_study.evidence.json");
      expect(await request).toBe(true);
    });
    expect(apiMocks.createProject).toHaveBeenCalledWith({
      project_file: "D:\\research\\new_study.evidence.json",
      name: "new_study"
    });
    expect(actions.resetAiDecisions).toHaveBeenCalledOnce();
    expect(actions.invalidateDraftGuard).toHaveBeenCalledOnce();
    expect(actions.resetEvidenceForNewProject).toHaveBeenCalledOnce();
    expect(actions.showEvidenceWorkspace).toHaveBeenCalledOnce();
    expect(actions.resetCodebook).toHaveBeenCalledOnce();
    expect(actions.resetTranscriptImport).toHaveBeenCalledOnce();
    expect(actions.onStatusMessage).toHaveBeenCalledWith("Created new coding project.");
  });

  it("completes a project operation after Strict Mode effect replay", async () => {
    const { result, actions } = renderLifecycle(null, true);

    await act(async () => { expect(await result.current.newProject()).toBe(true); });

    expect(actions.activateProjectSession).toHaveBeenCalledOnce();
    expect(actions.onStatusMessage).toHaveBeenCalledWith("Created new coding project.");
    expect(result.current.isLocked()).toBe(false);
  });

  it("opens and reloads authoritative projects with their established reconciliation", async () => {
    const opened = payload(makeProject("project_open"), makeHandle("project_open", "b", "opened"));
    apiMocks.loadProject.mockResolvedValue(opened);
    const openHook = renderLifecycle();
    await act(async () => { expect(await openHook.result.current.openProject()).toBe(true); });
    expect(openHook.actions.resetEvidenceForOpenProject).toHaveBeenCalledWith(opened.project);
    expect(openHook.actions.resetTranscriptImport).toHaveBeenCalledOnce();
    expect(openHook.actions.onStatusMessage).toHaveBeenCalledWith("Opened opened.evidence.json.");

    const reloaded = payload(makeProject("project_a", "Reloaded"), makeHandle("project_a", "c"));
    apiMocks.loadProject.mockResolvedValue(reloaded);
    const reloadHook = renderLifecycle(payload());
    await act(async () => { expect(await reloadHook.result.current.reload()).toBe(true); });
    expect(reloadHook.actions.resetEvidenceForReload).toHaveBeenCalledWith(reloaded.project);
    expect(reloadHook.actions.resetCodebook).toHaveBeenCalledOnce();
    expect(reloadHook.actions.resetTranscriptImport).not.toHaveBeenCalled();
    expect(reloadHook.actions.onStatusMessage).toHaveBeenCalledWith("Reloaded project_a.evidence.json.");
  });

  it("Save As uses immutable project and handle snapshots and retains import state", async () => {
    const initial = payload();
    const saving = deferred<CodesProjectPayload>();
    apiMocks.saveProject.mockReturnValue(saving.promise);
    const { result, actions, replaceSession } = renderLifecycle(initial);
    let request!: Promise<boolean>;
    act(() => { request = result.current.saveAs(); });
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledWith(
        "D:\\research\\saved.evidence.json",
        initial.project,
        initial.handle
      ));
    const saved = payload(initial.project, makeHandle("project_a", "b", "saved"));
    await act(async () => {
      saving.resolve(saved);
      expect(await request).toBe(true);
    });
    expect(actions.reconcileEvidenceAfterSaveAs).toHaveBeenCalledWith(saved.project);
    expect(actions.resetTranscriptImport).not.toHaveBeenCalled();
    expect(actions.invalidateDraftGuard).not.toHaveBeenCalled();
    replaceSession(saved);
  });

  it.each([
    "missing project",
    "missing project file",
    "missing handle",
    "mismatched project IDs",
    "mismatched project and handle files"
  ] as const)("rejects Save As, Reload, and Close before ownership for %s", async (variant) => {
    const initial = payload();
    const hook = renderLifecycle(initial);
    const coherent = hook.getSession();
    const invalid: CodesProjectSessionSnapshot = variant === "missing project"
      ? { ...coherent, project: null }
      : variant === "missing project file"
        ? { ...coherent, projectFile: null }
        : variant === "missing handle"
          ? { ...coherent, projectHandle: null }
          : variant === "mismatched project IDs"
            ? { ...coherent, projectHandle: { ...initial.handle, project_id: "project_other" } }
            : { ...coherent, projectFile: "D:\\research\\other.evidence.json" };
    hook.setSession(invalid);

    await act(async () => {
      expect(await hook.result.current.saveAs()).toBe(false);
      expect(await hook.result.current.reload()).toBe(false);
    });
    expect(hook.result.current.close()).toBe(false);
    expect(apiMocks.pickSave).not.toHaveBeenCalled();
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
    expect(apiMocks.saveProject).not.toHaveBeenCalled();
    expect(hook.actions.onOperationStarted).not.toHaveBeenCalled();
    expect(hook.actions.onStatusMessage).not.toHaveBeenCalled();
    expect(hook.actions.onError).not.toHaveBeenCalled();
    expect(hook.actions.clearProjectSession).not.toHaveBeenCalled();
  });

  it("refuses project operations while an external workflow or another project operation owns the lock", async () => {
    const picker = deferred<string | null>();
    apiMocks.pickOpen.mockReturnValue(picker.promise);
    const { result, setExternallyLocked } = renderLifecycle();
    setExternallyLocked(true);
    await act(async () => { expect(await result.current.openProject()).toBe(false); });
    expect(apiMocks.pickOpen).not.toHaveBeenCalled();
    setExternallyLocked(false);
    let opening!: Promise<boolean>;
    act(() => { opening = result.current.openProject(); });
    expect(result.current.close()).toBe(false);
    picker.resolve(null);
    await act(async () => { await opening; });
  });

  it("suppresses stale picker and API outcomes after invalidation or session replacement", async () => {
    const picker = deferred<string | null>();
    apiMocks.pickOpen.mockReturnValue(picker.promise);
    const hook = renderLifecycle();
    let opening!: Promise<boolean>;
    act(() => { opening = hook.result.current.openProject(); });
    hook.unmount();
    await act(async () => {
      picker.resolve("D:\\research\\old.evidence.json");
      expect(await opening).toBe(false);
    });
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
    expect(hook.actions.onError).not.toHaveBeenCalled();

    const loading = deferred<CodesProjectPayload>();
    apiMocks.loadProject.mockReturnValue(loading.promise);
    const second = renderLifecycle(payload());
    let reload!: Promise<boolean>;
    act(() => { reload = second.result.current.reload(); });
    second.replaceSession(payload(makeProject("project_b"), makeHandle("project_b")));
    await act(async () => {
      loading.resolve(payload(makeProject("project_a", "Old"), makeHandle("project_a", "b")));
      expect(await reload).toBe(false);
    });
    expect(second.actions.activateProjectSession).not.toHaveBeenCalled();
    expect(second.actions.onStatusMessage).not.toHaveBeenCalled();
  });

  it("ignores late load and save outcomes after a genuine unmount", async () => {
    const loading = deferred<CodesProjectPayload>();
    const saving = deferred<CodesProjectPayload>();
    apiMocks.loadProject.mockReturnValue(loading.promise);
    apiMocks.saveProject.mockReturnValue(saving.promise);

    const loadHook = renderLifecycle(payload());
    let loadingRequest!: Promise<boolean>;
    act(() => { loadingRequest = loadHook.result.current.reload(); });
    loadHook.unmount();
    await act(async () => {
      loading.resolve(payload(makeProject("project_a", "Late load"), makeHandle("project_a", "b")));
      expect(await loadingRequest).toBe(false);
    });
    expect(loadHook.actions.activateProjectSession).not.toHaveBeenCalled();
    expect(loadHook.actions.resetEvidenceForReload).not.toHaveBeenCalled();
    expect(loadHook.actions.onStatusMessage).not.toHaveBeenCalled();
    expect(loadHook.actions.onError).not.toHaveBeenCalled();

    const saveHook = renderLifecycle(payload());
    let savingRequest!: Promise<boolean>;
    act(() => { savingRequest = saveHook.result.current.saveAs(); });
    await waitFor(() => expect(apiMocks.saveProject).toHaveBeenCalledOnce());
    saveHook.unmount();
    await act(async () => {
      saving.reject(new Error("Late save failure"));
      expect(await savingRequest).toBe(false);
    });
    expect(saveHook.actions.activateProjectSession).not.toHaveBeenCalled();
    expect(saveHook.actions.reconcileEvidenceAfterSaveAs).not.toHaveBeenCalled();
    expect(saveHook.actions.onStatusMessage).not.toHaveBeenCalled();
    expect(saveHook.actions.onError).not.toHaveBeenCalled();
  });

  it("suppresses stale failures and conflicts without clearing newer status", async () => {
    const loading = deferred<CodesProjectPayload>();
    apiMocks.loadProject.mockReturnValue(loading.promise);
    const hook = renderLifecycle(payload());
    let reload!: Promise<boolean>;
    act(() => { reload = hook.result.current.reload(); });
    hook.replaceSession(payload(makeProject("project_a"), makeHandle("project_a", "b")));
    await act(async () => {
      loading.reject(new Error("stale failure"));
      expect(await reload).toBe(false);
    });
    expect(hook.actions.onError).not.toHaveBeenCalled();
  });

  it("closes synchronously with complete reset", () => {
    const hook = renderLifecycle(payload());
    act(() => { expect(hook.result.current.close()).toBe(true); });
    expect(hook.actions.resetAiDecisions).toHaveBeenCalledOnce();
    expect(hook.actions.invalidateDraftGuard).toHaveBeenCalledOnce();
    expect(hook.actions.clearProjectSession).toHaveBeenCalledOnce();
    expect(hook.actions.resetEvidenceForClose).toHaveBeenCalledOnce();
    expect(hook.actions.resetCodebook).toHaveBeenCalledOnce();
    expect(hook.actions.resetTranscriptImport).toHaveBeenCalledOnce();
    expect(hook.actions.onClose).toHaveBeenCalledOnce();
    expect(hook.actions.onStatusMessage).toHaveBeenCalledWith("No Coding Project Open");
    hook.unmount();
  });
});
