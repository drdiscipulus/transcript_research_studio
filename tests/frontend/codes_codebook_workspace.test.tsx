import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCallback, useRef, useState } from "react";
import { useCodesCodebookWorkspace } from "../../src/hooks/useCodesCodebookWorkspace";
import { ApiError, CodesProjectConflictError, type CodesProject, type CodesProjectHandle } from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  createCode: vi.fn(),
  updateCode: vi.fn(),
  deleteCode: vi.fn(),
  mergeCode: vi.fn(),
  createTheme: vi.fn(),
  updateTheme: vi.fn(),
  deleteTheme: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    createCodesCode: apiMocks.createCode,
    updateCodesCode: apiMocks.updateCode,
    deleteCodesCode: apiMocks.deleteCode,
    mergeCodesCode: apiMocks.mergeCode,
    createCodesTheme: apiMocks.createTheme,
    updateCodesTheme: apiMocks.updateTheme,
    deleteCodesTheme: apiMocks.deleteTheme
  };
});

function makeProject(revision = "a", projectId = "project_a"): CodesProject {
  return {
    schema_version: "1.1", project_id: projectId, name: "Study", created_at: "", updated_at: "", research_focus: "",
    ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
    transcripts: [], evidence_items: [], codes: [], themes: [], report_drafts: [], suggestion_decisions: [],
    settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" },
    id_counters: { revision }
  };
}

function makeHandle(projectId = "project_a", revision = "a", file = "project_a"): CodesProjectHandle {
  return { project_file: `D:\\research\\${file}.evidence.json`, project_id: projectId, revision: revision.repeat(64) };
}

function persisted(project = makeProject(), handle = makeHandle()) {
  return { project, handle };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function renderWorkspace(externalLock = { current: false }) {
  const conflicts: unknown[] = [];
  const deleted: string[] = [];
  const saveErrors: unknown[] = [];
  const saveStarted = vi.fn();
  const hook = renderHook(() => {
    const [session, setSession] = useState(() => persisted());
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const getCurrentSession = useCallback(() => ({
      project: sessionRef.current.project,
      projectFile: sessionRef.current.handle.project_file,
      projectHandle: sessionRef.current.handle,
      projectConflict: null,
      settingsDirty: false
    }), []);
    const applyPersistedProject = useCallback((payload: typeof session) => {
      const current = sessionRef.current;
      if (current.project.project_id !== payload.project.project_id || current.handle.project_file !== payload.handle.project_file) return false;
      sessionRef.current = payload;
      setSession(payload);
      return true;
    }, []);
    return {
      session,
      replaceSession: setSession,
      workspace: useCodesCodebookWorkspace({
        getCurrentSession,
        applyPersistedProject,
        persistProjectSettings: async () => sessionRef.current,
        isExternallyLocked: () => externalLock.current,
        onProjectConflict: (conflict) => conflicts.push(conflict),
        onSaveStarted: saveStarted,
        onSaveError: (error) => saveErrors.push(error),
        onCodeDeleted: (id) => deleted.push(id)
      })
    };
  });
  return { ...hook, conflicts, deleted, saveErrors, saveStarted };
}

describe("Codes codebook workspace lifecycle", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
  });
  it("reports whether contextual AI draft application was accepted", () => {
    const externalLock = { current: false };
    const { result } = renderWorkspace(externalLock);
    const code = { code_id: "C000001", name: "Code", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const theme = { theme_id: "TH000001", name: "Theme", description: "", color: "#123456", code_ids: [], memo: "", created_at: "", updated_at: "" };

    act(() => {
      result.current.workspace.selectCode(code);
      result.current.workspace.selectTheme(theme);
      expect(result.current.workspace.tryUpdateCodeForm(code.code_id, (current) => ({ ...current, description: "Refined" }))).toBe(true);
      expect(result.current.workspace.tryUpdateThemeForm(theme.theme_id, (current) => ({ ...current, description: "Grouped" }))).toBe(true);
      expect(result.current.workspace.tryOpenNewTheme({ ...result.current.workspace.themeForm, name: "Proposed" })).toBe(true);
    });
    expect(result.current.workspace.codeForm.description).toBe("Refined");
    expect(result.current.workspace.themeForm.description).toBe("Grouped");
    expect(result.current.workspace.themeDialogOpen).toBe(true);

    externalLock.current = true;
    expect(result.current.workspace.tryUpdateCodeForm(code.code_id, (current) => ({ ...current, description: "Rejected" }))).toBe(false);
    expect(result.current.workspace.tryUpdateThemeForm(theme.theme_id, (current) => ({ ...current, description: "Rejected" }))).toBe(false);
    expect(result.current.workspace.tryOpenNewTheme()).toBe(false);
    expect(result.current.workspace.codeForm.description).toBe("Refined");
    expect(result.current.workspace.themeForm.description).toBe("Grouped");
  });
  it("rejects an old contextual target immediately after same-batch entity replacement", () => {
    const { result } = renderWorkspace();
    const firstCode = { code_id: "C000001", name: "First", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const secondCode = { ...firstCode, code_id: "C000002", name: "Second" };
    const firstTheme = { theme_id: "TH000001", name: "First", description: "", color: "#123456", code_ids: [], memo: "", created_at: "", updated_at: "" };
    const secondTheme = { ...firstTheme, theme_id: "TH000002", name: "Second" };

    act(() => {
      result.current.workspace.selectCode(firstCode);
      result.current.workspace.selectTheme(firstTheme);
      result.current.workspace.selectCode(secondCode);
      result.current.workspace.selectTheme(secondTheme);
      expect(result.current.workspace.tryUpdateCodeForm(firstCode.code_id, (current) => ({ ...current, description: "Stale" }))).toBe(false);
      expect(result.current.workspace.tryUpdateThemeForm(firstTheme.theme_id, (current) => ({ ...current, description: "Stale" }))).toBe(false);
      expect(result.current.workspace.tryUpdateCodeForm(secondCode.code_id, (current) => ({ ...current, description: "Current" }))).toBe(true);
      expect(result.current.workspace.tryUpdateThemeForm(secondTheme.theme_id, (current) => ({ ...current, description: "Current" }))).toBe(true);
    });
    expect(result.current.workspace.codeForm).toEqual(expect.objectContaining({ codeId: "C000002", description: "Current" }));
    expect(result.current.workspace.themeForm).toEqual(expect.objectContaining({ themeId: "TH000002", description: "Current" }));
  });
  it("creates a code from an immutable form snapshot and selects the authoritative response", async () => {
    const { result } = renderWorkspace();
    const created = { code_id: "C000001", name: "Discovery", description: "Definition", inclusion_note: "Include", exclusion_note: "Exclude", example_evidence_ids: ["E1"], color: "#123456", memo: "Memo", created_at: "", updated_at: "" };
    apiMocks.createCode.mockResolvedValueOnce({ ...persisted({ ...makeProject(), codes: [created] }, makeHandle("project_a", "b")), code: created, project_id: "project_a", project_file: makeHandle().project_file, revision: makeHandle("project_a", "b").revision });
    await act(async () => {
      await result.current.workspace.createCode({ codeId: "", name: "Discovery", description: "Definition", inclusionNote: "Include", exclusionNote: "Exclude", exampleEvidenceIds: ["E1"], color: "#123456", memo: "Memo", aiDecisions: [], useCurrentEvidenceAsExample: false });
    });
    expect(apiMocks.createCode).toHaveBeenCalledWith(expect.objectContaining({ name: "Discovery", example_evidence_ids: ["E1"], ai_decisions: [] }));
    expect(result.current.workspace.codeForm).toEqual(expect.objectContaining({ codeId: "C000001", name: "Discovery" }));
  });

  it("blocks a duplicate mutation immediately and ignores a late response after reset", async () => {
    const { result } = renderWorkspace();
    const pending = deferred<unknown>();
    apiMocks.createCode.mockReturnValueOnce(pending.promise);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.workspace.createCode({ codeId: "", name: "One", description: "", inclusionNote: "", exclusionNote: "", exampleEvidenceIds: [], color: "#123456", memo: "", aiDecisions: [], useCurrentEvidenceAsExample: false });
      second = result.current.workspace.createCode({ codeId: "", name: "Two", description: "", inclusionNote: "", exclusionNote: "", exampleEvidenceIds: [], color: "#123456", memo: "", aiDecisions: [], useCurrentEvidenceAsExample: false });
    });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.workspace.reset());
    expect(await second).toBe(false);
    await act(async () => { pending.resolve({ ...persisted(), code: { code_id: "C000001" } }); await first; });
    expect(apiMocks.createCode).toHaveBeenCalledTimes(1);
    expect(result.current.workspace.codeForm.codeId).toBeNull();
  });

  it("does not acquire the merge lock until both source and target are valid", async () => {
    const { result } = renderWorkspace();
    await act(async () => {
      expect(await result.current.workspace.mergeCode("C000002", { name: "", description: "", inclusion_note: "", exclusion_note: "", memo: "", example_evidence_ids: [] })).toBe(false);
      expect(await result.current.workspace.mergeCode("", { name: "", description: "", inclusion_note: "", exclusion_note: "", memo: "", example_evidence_ids: [] })).toBe(false);
    });
    expect(result.current.workspace.busy).toBe(false);
    expect(result.current.workspace.isLocked()).toBe(false);
    const created = { code_id: "C000001", name: "Available", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const nextHandle = makeHandle("project_a", "b");
    apiMocks.createCode.mockResolvedValueOnce({ ...persisted({ ...makeProject(), codes: [created] }, nextHandle), code: created, project_id: "project_a", project_file: nextHandle.project_file, revision: nextHandle.revision });
    await act(async () => { await result.current.workspace.createCode({ codeId: "", name: "Available", description: "", inclusionNote: "", exclusionNote: "", exampleEvidenceIds: [], color: "#123456", memo: "", aiDecisions: [], useCurrentEvidenceAsExample: false }); });
    expect(apiMocks.createCode).toHaveBeenCalledOnce();
  });

  it("merges into the authoritative target and clears the merge source", async () => {
    const { result } = renderWorkspace();
    const source = { code_id: "C000001", name: "Source", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const target = { ...source, code_id: "C000002", name: "Target" };
    const project = { ...makeProject(), codes: [source, target] };
    const nextHandle = makeHandle("project_a", "b");
    act(() => {
      result.current.replaceSession(persisted(project));
      result.current.workspace.openMergeCode(source.code_id);
    });
    apiMocks.mergeCode.mockResolvedValueOnce({
      ...persisted({ ...project, codes: [{ ...target, description: "Merged" }] }, nextHandle),
      source_code_id: source.code_id,
      target_code: { ...target, description: "Merged" },
      project_id: "project_a",
      project_file: nextHandle.project_file,
      revision: nextHandle.revision
    });
    await act(async () => {
      await result.current.workspace.mergeCode(target.code_id, { name: "Target", description: "Merged", inclusion_note: "", exclusion_note: "", memo: "", example_evidence_ids: [] });
    });
    expect(apiMocks.mergeCode).toHaveBeenCalledWith(expect.anything(), expect.anything(), source.code_id, target.code_id, expect.objectContaining({ description: "Merged" }));
    expect(result.current.workspace.codeForm).toEqual(expect.objectContaining({ codeId: target.code_id, description: "Merged" }));
    expect(result.current.workspace.mergeSourceCodeId).toBe("");
  });

  it("keeps current save failures scoped but suppresses stale rejections after reset or session replacement", async () => {
    const { result, saveErrors, saveStarted } = renderWorkspace();
    const code = { code_id: "C000001", name: "Draft", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    act(() => { result.current.replaceSession(persisted({ ...makeProject(), codes: [code] })); result.current.workspace.selectCode(code); });
    apiMocks.updateCode.mockRejectedValueOnce(new Error("Current save failed."));
    await act(async () => { await result.current.workspace.saveCode(); });
    expect(saveStarted).toHaveBeenCalledOnce();
    expect(saveErrors).toHaveLength(1);
    expect(result.current.workspace.entityEditorError).toBe("Current save failed.");
    const pending = deferred<unknown>();
    apiMocks.updateCode.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveCode(); });
    await act(async () => { await Promise.resolve(); });
    act(() => {
      result.current.workspace.reset();
      result.current.replaceSession(persisted(makeProject("project_b"), makeHandle("project_b", "a", "project_b")));
    });
    await act(async () => { pending.reject(new Error("Stale failure.")); await saving; });
    expect(saveErrors).toHaveLength(1);
    expect(result.current.workspace.entityEditorError).toBeNull();
  });

  it.each(["file", "revision"])("suppresses stale code-save failures after a %s replacement", async (replacement) => {
    const { result, saveErrors } = renderWorkspace();
    const code = { code_id: "C000001", name: "Draft", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const pending = deferred<unknown>();
    act(() => {
      result.current.replaceSession(persisted({ ...makeProject(), codes: [code] }));
      result.current.workspace.selectCode(code);
    });
    apiMocks.updateCode.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveCode(); });
    await act(async () => { await Promise.resolve(); });
    const replacementHandle = replacement === "file"
      ? makeHandle("project_a", "a", "copy")
      : makeHandle("project_a", "b");
    act(() => result.current.replaceSession(persisted({ ...makeProject(), codes: [code] }, replacementHandle)));
    await act(async () => { pending.reject(new Error("Stale failure.")); await saving; });
    expect(saveErrors).toEqual([]);
    expect(result.current.workspace.entityEditorError).toBeNull();
  });

  it("suppresses a stale theme-save rejection after unmount", async () => {
    const { result, unmount, saveErrors } = renderWorkspace();
    const theme = { theme_id: "TH000001", name: "Theme", description: "", color: "#123456", code_ids: [], memo: "", created_at: "", updated_at: "" };
    const pending = deferred<unknown>();
    act(() => {
      result.current.replaceSession(persisted({ ...makeProject(), themes: [theme] }));
      result.current.workspace.selectTheme(theme);
    });
    apiMocks.updateTheme.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveTheme(); });
    await act(async () => { await Promise.resolve(); });
    unmount();
    await act(async () => { pending.reject(new Error("Unmounted failure.")); await saving; });
    expect(saveErrors).toEqual([]);
  });

  it("uses the current Save As file and revision for a later mutation", async () => {
    const { result } = renderWorkspace();
    const code = { code_id: "C000001", name: "Saved elsewhere", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const savedAsHandle = makeHandle("project_a", "b", "copy");
    act(() => result.current.replaceSession(persisted({ ...makeProject(), codes: [code] }, savedAsHandle)));
    act(() => result.current.workspace.selectCode(code));
    const nextHandle = makeHandle("project_a", "c", "copy");
    apiMocks.updateCode.mockResolvedValueOnce({ ...persisted({ ...makeProject(), codes: [code] }, nextHandle), code, project_id: "project_a", project_file: nextHandle.project_file, revision: nextHandle.revision });
    await act(async () => { await result.current.workspace.saveCode(); });
    expect(apiMocks.updateCode).toHaveBeenCalledWith(expect.objectContaining({ handle: expect.objectContaining({ project_file: savedAsHandle.project_file, revision: savedAsHandle.revision }) }));
  });

  it("silently ignores a stale successful save after the file or revision changes", async () => {
    const { result, saveErrors } = renderWorkspace();
    const code = { code_id: "C000001", name: "Draft", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const pending = deferred<unknown>();
    act(() => {
      result.current.replaceSession(persisted({ ...makeProject(), codes: [code] }));
      result.current.workspace.selectCode(code);
    });
    apiMocks.updateCode.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.workspace.saveCode(); });
    await act(async () => { await Promise.resolve(); });
    const replacementHandle = makeHandle("project_a", "b", "copy");
    act(() => result.current.replaceSession(persisted({ ...makeProject(), codes: [{ ...code, name: "Replacement" }] }, replacementHandle)));
    const responseHandle = makeHandle("project_a", "b");
    await act(async () => {
      pending.resolve({ ...persisted({ ...makeProject(), codes: [{ ...code, name: "Old response" }] }, responseHandle), code, project_id: "project_a", project_file: responseHandle.project_file, revision: responseHandle.revision });
      expect(await saving).toBe(false);
    });
    expect(result.current.workspace.codeForm.name).toBe("Draft");
    expect(saveErrors).toHaveLength(0);
  });

  it("forwards a current project conflict once while retaining the code draft", async () => {
    const { result, conflicts, saveErrors } = renderWorkspace();
    const code = { code_id: "C000001", name: "Draft", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    act(() => {
      result.current.replaceSession(persisted({ ...makeProject(), codes: [code] }));
      result.current.workspace.selectCode(code);
      result.current.workspace.updateCodeForm((current) => ({ ...current, name: "Retained" }));
    });
    const conflict = new CodesProjectConflictError(new ApiError({ message: "Project changed elsewhere.", kind: "http", status: 409 }), "b".repeat(64));
    apiMocks.updateCode.mockRejectedValueOnce(conflict);
    await act(async () => { await result.current.workspace.saveCode(); });
    expect(conflicts).toEqual([conflict]);
    expect(saveErrors).toEqual([conflict]);
    expect(result.current.workspace.codeForm.name).toBe("Retained");
  });

  it("retains a theme draft locally when an external lock rejects persistence", async () => {
    const externalLock = { current: true };
    const hook = renderHook(() => {
      const session = useRef(persisted());
      return useCodesCodebookWorkspace({
        getCurrentSession: () => ({ project: session.current.project, projectFile: session.current.handle.project_file, projectHandle: session.current.handle, projectConflict: null, settingsDirty: false }),
        applyPersistedProject: () => true,
        persistProjectSettings: async () => session.current,
        isExternallyLocked: () => externalLock.current
      });
    });
    act(() => hook.result.current.updateThemeForm((current) => ({ ...current, name: "Theme" })));
    await act(async () => { expect(await hook.result.current.saveTheme()).toBe(false); });
    expect(hook.result.current.themeForm.name).toBe("Theme");
  });

  it("updates every code field and preserves AI decision metadata", async () => {
    const { result } = renderWorkspace();
    const code = { code_id: "C000001", name: "Original", description: "Old", inclusion_note: "Old inclusion", exclusion_note: "Old exclusion", example_evidence_ids: ["E1"], color: "#123456", memo: "Old memo", created_at: "", updated_at: "" };
    const project = { ...makeProject(), codes: [code] };
    const nextCode = { ...code, name: "Revised", description: "New", inclusion_note: "Include", exclusion_note: "Exclude", example_evidence_ids: ["E2"], memo: "New memo" };
    act(() => result.current.replaceSession(persisted(project)));
    act(() => {
      result.current.workspace.selectCode(code);
      result.current.workspace.updateCodeForm((current) => ({ ...current, name: "Revised", description: "New", inclusionNote: "Include", exclusionNote: "Exclude", exampleEvidenceIds: ["E2"], memo: "New memo", aiDecisions: [{ run_id: "run_1", suggestion_id: "suggestion_1", task: "code_refinement", decision: "edited" }] }));
    });
    const handle = makeHandle("project_a", "b");
    apiMocks.updateCode.mockResolvedValueOnce({ ...persisted({ ...project, codes: [nextCode] }, handle), code: nextCode, project_id: "project_a", project_file: handle.project_file, revision: handle.revision });
    await act(async () => { await result.current.workspace.saveCode(); });
    expect(apiMocks.updateCode).toHaveBeenCalledWith(expect.objectContaining({ code_id: "C000001", name: "Revised", inclusion_note: "Include", exclusion_note: "Exclude", example_evidence_ids: ["E2"], memo: "New memo", ai_decisions: [{ run_id: "run_1", suggestion_id: "suggestion_1", task: "code_refinement", decision: "edited" }] }));
    expect(result.current.workspace.codeForm).toEqual(expect.objectContaining({ codeId: "C000001", name: "Revised" }));
  });

  it("deletes a code, invokes narrow evidence cleanup, and clears theme membership", async () => {
    const { result, deleted } = renderWorkspace();
    const code = { code_id: "C000001", name: "Delete", description: "", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#123456", memo: "", created_at: "", updated_at: "" };
    const theme = { theme_id: "TH000001", name: "Theme", description: "", color: "#123456", code_ids: [code.code_id], memo: "", created_at: "", updated_at: "" };
    const project = { ...makeProject(), codes: [code], themes: [theme] };
    act(() => { result.current.replaceSession(persisted(project)); result.current.workspace.selectTheme(theme); });
    const handle = makeHandle("project_a", "b");
    apiMocks.deleteCode.mockResolvedValueOnce({ ...persisted({ ...project, codes: [], themes: [{ ...theme, code_ids: [] }] }, handle), code_id: code.code_id, project_id: "project_a", project_file: handle.project_file, revision: handle.revision });
    await act(async () => { await result.current.workspace.deleteCode(code); });
    expect(deleted).toEqual([code.code_id]);
    expect(result.current.workspace.themeForm.codeIds).toEqual([]);
  });

  it("creates, updates, and deletes themes through the active project session", async () => {
    const { result } = renderWorkspace();
    const theme = { theme_id: "TH000001", name: "Theme", description: "Description", color: "#123456", code_ids: [], memo: "Note", created_at: "", updated_at: "" };
    const firstHandle = makeHandle("project_a", "b");
    apiMocks.createTheme.mockResolvedValueOnce({ ...persisted({ ...makeProject(), themes: [theme] }, firstHandle), theme, project_id: "project_a", project_file: firstHandle.project_file, revision: firstHandle.revision });
    await act(async () => { await result.current.workspace.createTheme({ themeId: "", name: "Theme", description: "Description", color: "#123456", codeIds: [], memo: "Note", aiDecisions: [] }); });
    expect(result.current.workspace.themeForm).toEqual(expect.objectContaining({ themeId: "TH000001", name: "Theme" }));
    const secondHandle = makeHandle("project_a", "c");
    apiMocks.updateTheme.mockResolvedValueOnce({ ...persisted({ ...makeProject(), themes: [{ ...theme, name: "Revised" }] }, secondHandle), theme: { ...theme, name: "Revised" }, project_id: "project_a", project_file: secondHandle.project_file, revision: secondHandle.revision });
    act(() => result.current.workspace.updateThemeForm((current) => ({ ...current, name: "Revised" })));
    await act(async () => { await result.current.workspace.saveTheme(); });
    expect(apiMocks.updateTheme).toHaveBeenCalledWith(expect.objectContaining({ theme_id: "TH000001", name: "Revised" }));
    const finalHandle = makeHandle("project_a", "d");
    apiMocks.deleteTheme.mockResolvedValueOnce({ ...persisted({ ...makeProject(), themes: [] }, finalHandle), theme_id: "TH000001", project_id: "project_a", project_file: finalHandle.project_file, revision: finalHandle.revision });
    await act(async () => { await result.current.workspace.deleteTheme({ ...theme, name: "Revised" }); });
    expect(result.current.workspace.themeForm.themeId).toBeNull();
  });

  it("toggles theme membership locally without mutating the project before Save", () => {
    const { result } = renderWorkspace();
    const theme = { theme_id: "TH000001", name: "Theme", description: "", color: "#123456", code_ids: ["C000001"], memo: "", created_at: "", updated_at: "" };
    act(() => {
      result.current.replaceSession(persisted({ ...makeProject(), themes: [theme] }));
      result.current.workspace.selectTheme(theme);
      result.current.workspace.toggleThemeCode("C000002");
      result.current.workspace.toggleThemeCode("C000001");
    });
    expect(result.current.workspace.themeForm.codeIds).toEqual(["C000002"]);
    expect(result.current.session.project.themes[0].code_ids).toEqual(["C000001"]);
  });
});
