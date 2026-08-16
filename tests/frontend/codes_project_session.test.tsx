import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodesProjectSession } from "../../src/hooks/useCodesProjectSession";
import type { CodesProject, CodesProjectHandle } from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  saveProject: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    saveCodesProject: apiMocks.saveProject
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

function makeProject(projectId = "project_a", overrides: Partial<CodesProject> = {}): CodesProject {
  return {
    schema_version: "1.1",
    project_id: projectId,
    name: "Study",
    created_at: "2026-08-05T10:00:00Z",
    updated_at: "2026-08-05T10:00:00Z",
    research_focus: "Original focus",
    ai_settings: {
      provider_id: "lmstudio",
      model_id: "local-model",
      temperature: 0,
      timeout_seconds: 180,
      suggestion_language: "auto",
      prompt_overrides: {
        evidence: "Evidence prompt",
        codes: "Codes prompt",
        note: "Note prompt",
        codebook: "Codebook prompt",
        themes: "Themes prompt"
      }
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
    id_counters: {},
    ...overrides
  };
}

function makeHandle(projectId = "project_a", revision = "a", fileName = projectId): CodesProjectHandle {
  return {
    project_file: `D:\\research\\${fileName}.evidence.json`,
    project_id: projectId,
    revision: revision.repeat(64)
  };
}

function persisted(project = makeProject(), handle = makeHandle()) {
  return { project, handle };
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function renderSession(strict = false) {
  const onSettingsSaveStarted = vi.fn();
  const onSettingsSaveError = vi.fn();
  const onSettingsSaved = vi.fn();
  const hook = renderHook(() => useCodesProjectSession({
    onSettingsSaveStarted,
    onSettingsSaveError,
    onSettingsSaved
  }), strict ? { wrapper: StrictModeWrapper } : undefined);
  return { ...hook, onSettingsSaveStarted, onSettingsSaveError, onSettingsSaved };
}

describe("Codes project session", () => {
  beforeEach(() => {
    apiMocks.saveProject.mockReset().mockImplementation(async (_file, project, handle) => ({
      project,
      handle: { ...handle, revision: "b".repeat(64) }
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies a persisted project to state and synchronous session access", () => {
    const { result } = renderSession();
    const payload = persisted();

    act(() => result.current.activateProjectSession(payload));
    const updated = persisted(
      makeProject("project_a", { name: "Persisted update" }),
      makeHandle("project_a", "b")
    );
    act(() => {
      expect(result.current.applyPersistedProject(updated)).toBe(true);
    });

    expect(result.current.project).toBe(updated.project);
    expect(result.current.projectFile).toBe(updated.handle.project_file);
    expect(result.current.projectHandle).toBe(updated.handle);
    expect(result.current.getCurrentSession()).toEqual({
      project: updated.project,
      projectFile: updated.handle.project_file,
      projectHandle: updated.handle,
      projectConflict: null,
      settingsDirty: false
    });
  });

  it("clears the complete active project identity", () => {
    const { result } = renderSession();
    act(() => result.current.activateProjectSession(persisted()));

    act(() => result.current.clearProjectSession());

    expect(result.current.getCurrentSession()).toEqual({
      project: null,
      projectFile: null,
      projectHandle: null,
      projectConflict: null,
      settingsDirty: false
    });
    expect(result.current.settingsSaveState).toBe("saved");
  });

  it("marks a local settings update dirty immediately", () => {
    const { result } = renderSession();
    act(() => result.current.activateProjectSession(persisted()));

    act(() => result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Revised" })));

    expect(result.current.project?.name).toBe("Revised");
    expect(result.current.settingsDirty).toBe(true);
    expect(result.current.getCurrentSession().settingsDirty).toBe(true);
  });

  it("persists scheduled settings once", async () => {
    vi.useFakeTimers();
    const { result } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, research_focus: "Revised" }));
      result.current.scheduleSettingsPersistence();
      result.current.scheduleSettingsPersistence();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(apiMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(result.current.settingsDirty).toBe(false);
  });

  it("applies current settings persistence after Strict Mode effect replay", async () => {
    const { result, onSettingsSaved } = renderSession(true);
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, research_focus: "Strict focus" }));
    });

    await act(async () => { await result.current.persistSettingsImmediately(); });

    expect(result.current.settingsDirty).toBe(false);
    expect(onSettingsSaved).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent settings persistence", async () => {
    const pending = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject.mockReturnValue(pending.promise);
    const { result } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Revised" }));
    });

    let first!: Promise<ReturnType<typeof persisted> | null>;
    let second!: Promise<ReturnType<typeof persisted> | null>;
    act(() => {
      first = result.current.persistSettingsImmediately();
      second = result.current.persistSettingsImmediately();
    });
    expect(apiMocks.saveProject).toHaveBeenCalledTimes(1);

    const saved = persisted(makeProject("project_a", { name: "Revised" }), makeHandle("project_a", "b"));
    await act(async () => {
      pending.resolve(saved);
      await Promise.all([first, second]);
    });

    expect(apiMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(result.current.settingsDirty).toBe(false);
  });

  it("saves an edit made during an active save with the newer revision", async () => {
    const firstSave = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementationOnce(async (_file, project, handle) => ({
        project,
        handle: { ...handle, revision: "c".repeat(64) }
      }));
    const { result } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, research_focus: "First edit" }));
    });

    let saving!: Promise<ReturnType<typeof persisted> | null>;
    act(() => {
      saving = result.current.persistSettingsImmediately();
    });
    act(() => {
      result.current.updateProjectSettingsLocally((project) => ({ ...project, research_focus: "Newer edit" }));
    });

    let saved!: ReturnType<typeof persisted> | null;
    await act(async () => {
      firstSave.resolve(persisted(
        makeProject("project_a", { research_focus: "First edit" }),
        makeHandle("project_a", "b")
      ));
      saved = await saving;
    });

    expect(apiMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(apiMocks.saveProject.mock.calls[1][1]).toEqual(expect.objectContaining({ research_focus: "Newer edit" }));
    expect(apiMocks.saveProject.mock.calls[1][2]).toEqual(expect.objectContaining({ revision: "b".repeat(64) }));
    expect(saved?.project.research_focus).toBe("Newer edit");
    expect(saved?.handle.revision).toBe("c".repeat(64));
    expect(result.current.settingsDirty).toBe(false);
  });

  it("returns the exact successfully persisted project and handle", async () => {
    const returned = persisted(
      makeProject("project_a", { name: "Persisted name" }),
      makeHandle("project_a", "d")
    );
    apiMocks.saveProject.mockResolvedValue(returned);
    const { result } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Persisted name" }));
    });

    let saved!: ReturnType<typeof persisted> | null;
    await act(async () => {
      saved = await result.current.persistSettingsImmediately();
    });

    expect(saved).toEqual(returned);
    expect(saved?.project).toBe(returned.project);
    expect(saved?.handle).toBe(returned.handle);
  });

  it("preserves dirty values and reports a controlled settings failure", async () => {
    apiMocks.saveProject.mockRejectedValue(new Error("Project settings save failed."));
    const { result, onSettingsSaveError } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, research_focus: "Unsaved focus" }));
    });

    let saved!: ReturnType<typeof persisted> | null;
    await act(async () => {
      saved = await result.current.persistSettingsImmediately();
    });

    expect(saved).toBeNull();
    expect(result.current.project?.research_focus).toBe("Unsaved focus");
    expect(result.current.settingsDirty).toBe(true);
    expect(result.current.settingsSaveState).toBe("failed");
    expect(onSettingsSaveError).toHaveBeenCalledWith(expect.any(Error), "Project settings could not be saved.");
  });

  it("ignores a save success after the project session is replaced", async () => {
    const pending = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject.mockReturnValue(pending.promise);
    const { result, onSettingsSaved } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Old project edit" }));
    });
    let saving!: Promise<ReturnType<typeof persisted> | null>;
    act(() => {
      saving = result.current.persistSettingsImmediately();
    });
    const replacement = persisted(makeProject("project_b"), makeHandle("project_b"));
    act(() => result.current.activateProjectSession(replacement));

    let saved!: ReturnType<typeof persisted> | null;
    await act(async () => {
      pending.resolve(persisted(makeProject("project_a", { name: "Old project edit" }), makeHandle("project_a", "b")));
      saved = await saving;
    });

    expect(saved).toBeNull();
    expect(result.current.project).toBe(replacement.project);
    expect(result.current.projectHandle).toBe(replacement.handle);
    expect(onSettingsSaved).not.toHaveBeenCalled();
  });

  it("does not publish a stale save failure into a replacement session", async () => {
    const pending = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject.mockReturnValue(pending.promise);
    const { result, onSettingsSaveError } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Old project edit" }));
    });
    let saving!: Promise<ReturnType<typeof persisted> | null>;
    act(() => {
      saving = result.current.persistSettingsImmediately();
    });
    const replacement = persisted(makeProject("project_b"), makeHandle("project_b"));
    act(() => result.current.activateProjectSession(replacement));

    await act(async () => {
      pending.reject(new Error("Stale save failed."));
      await saving;
    });

    expect(result.current.project).toBe(replacement.project);
    expect(result.current.settingsSaveState).toBe("saved");
    expect(onSettingsSaveError).not.toHaveBeenCalled();
  });

  it("clears scheduled persistence on unmount", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderSession();
    act(() => {
      result.current.activateProjectSession(persisted());
      result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Revised" }));
      result.current.scheduleSettingsPersistence();
    });

    unmount();
    await vi.advanceTimersByTimeAsync(250);

    expect(apiMocks.saveProject).not.toHaveBeenCalled();
  });

  it("ignores late settings save success and failure after unmount", async () => {
    const pendingSuccess = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject.mockReturnValueOnce(pendingSuccess.promise);
    const successHook = renderSession();
    act(() => {
      successHook.result.current.activateProjectSession(persisted());
      successHook.result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Late success" }));
    });
    let success!: Promise<ReturnType<typeof persisted> | null>;
    act(() => { success = successHook.result.current.persistSettingsImmediately(); });
    successHook.unmount();
    await act(async () => {
      pendingSuccess.resolve(persisted(makeProject("project_a", { name: "Late success" }), makeHandle("project_a", "b")));
      expect(await success).toBeNull();
    });
    expect(successHook.onSettingsSaved).not.toHaveBeenCalled();
    expect(successHook.onSettingsSaveError).not.toHaveBeenCalled();

    const pendingFailure = deferred<ReturnType<typeof persisted>>();
    apiMocks.saveProject.mockReturnValueOnce(pendingFailure.promise);
    const failureHook = renderSession();
    act(() => {
      failureHook.result.current.activateProjectSession(persisted());
      failureHook.result.current.updateProjectSettingsLocally((project) => ({ ...project, name: "Late failure" }));
    });
    let failure!: Promise<ReturnType<typeof persisted> | null>;
    act(() => { failure = failureHook.result.current.persistSettingsImmediately(); });
    failureHook.unmount();
    await act(async () => {
      pendingFailure.reject(new Error("Late failure"));
      expect(await failure).toBeNull();
    });
    expect(failureHook.onSettingsSaved).not.toHaveBeenCalled();
    expect(failureHook.onSettingsSaveError).not.toHaveBeenCalled();
  });

  it("updates AI settings without dropping unchanged fields", () => {
    vi.useFakeTimers();
    const { result } = renderSession();
    act(() => result.current.activateProjectSession(persisted()));

    act(() => {
      result.current.updateProjectAiSettingsLocally({ temperature: 0.4 });
      result.current.cancelScheduledSettingsSave();
    });

    expect(result.current.project?.ai_settings).toEqual({
      provider_id: "lmstudio",
      model_id: "local-model",
      temperature: 0.4,
      timeout_seconds: 180,
      suggestion_language: "auto",
      prompt_overrides: {
        evidence: "Evidence prompt",
        codes: "Codes prompt",
        note: "Note prompt",
        codebook: "Codebook prompt",
        themes: "Themes prompt"
      }
    });
    expect(result.current.settingsDirty).toBe(true);
  });
});
