import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodesExportBundlePayload,
  CodesProject,
  CodesProjectHandle
} from "../../src/lib/api";
import { useCodesProjectExport } from "../../src/hooks/useCodesProjectExport";
import type { CodesProjectSessionSnapshot } from "../../src/hooks/useCodesProjectSession";

const apiMocks = vi.hoisted(() => ({
  pickBundleFile: vi.fn(),
  exportBundle: vi.fn(),
  openPath: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    pickCodesExportBundleFile: apiMocks.pickBundleFile,
    exportCodesProjectBundle: apiMocks.exportBundle,
    openPath: apiMocks.openPath
  };
});

const project: CodesProject = {
  schema_version: "1.1",
  project_id: "project_export",
  name: "Export Study",
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
  project_file: "D:\\research\\export-study.evidence.json",
  project_id: project.project_id,
  revision: "a".repeat(64)
};

const payload: CodesExportBundlePayload = {
  bundle: { path: "D:\\exports\\Export_Study_export.zip", exists: true, size: 4096 },
  artifacts: [{
    product: "xlsx",
    role: "analysis_workbook",
    archive_path: "analysis_workbook.xlsx",
    size: 2048
  }],
  warnings: ["QDPX remains beta."],
  manifest: { schema_version: "1.0" }
};

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

function renderExportHook(initialSession: CodesProjectSessionSnapshot = session(), desktopAvailable = true) {
  let currentSession = initialSession;
  const hook = renderHook(() => useCodesProjectExport({
    desktopAvailable,
    getCurrentSession: () => currentSession
  }));
  return {
    ...hook,
    replaceSession(nextSession: CodesProjectSessionSnapshot) {
      currentSession = nextSession;
      hook.rerender();
    }
  };
}

async function completeExport(hook: ReturnType<typeof renderExportHook>) {
  apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\requested.zip");
  apiMocks.exportBundle.mockResolvedValueOnce(payload);
  await act(async () => {
    await hook.result.current.exportProject();
  });
}

describe("useCodesProjectExport", () => {
  beforeEach(() => {
    apiMocks.pickBundleFile.mockReset();
    apiMocks.exportBundle.mockReset();
    apiMocks.openPath.mockReset().mockResolvedValue(undefined);
  });

  it("starts with privacy-first workbook defaults", () => {
    const hook = renderExportHook();
    expect(hook.result.current.products).toEqual(["xlsx"]);
    expect(hook.result.current.docxMode).toBe("separate");
    expect(hook.result.current.includeLocalPaths).toBe(false);
    expect(hook.result.current.includeAiAudit).toBe(false);
    expect(hook.result.current.busy).toBe(false);
  });

  it("toggles export products without duplicates", () => {
    const hook = renderExportHook();
    act(() => hook.result.current.toggleProduct("docx"));
    expect(hook.result.current.products).toEqual(["xlsx", "docx"]);
    act(() => hook.result.current.toggleProduct("xlsx"));
    expect(hook.result.current.products).toEqual(["docx"]);
  });

  it("updates DOCX and privacy preferences", () => {
    const hook = renderExportHook();
    act(() => {
      hook.result.current.setDocxMode("combined");
      hook.result.current.setIncludeLocalPaths(true);
      hook.result.current.setIncludeAiAudit(true);
    });
    expect(hook.result.current.docxMode).toBe("combined");
    expect(hook.result.current.includeLocalPaths).toBe(true);
    expect(hook.result.current.includeAiAudit).toBe(true);
  });

  it("does not open a picker outside the desktop app", async () => {
    const hook = renderExportHook(session(), false);
    await act(async () => hook.result.current.exportProject());
    expect(apiMocks.pickBundleFile).not.toHaveBeenCalled();
  });

  it("does not export when the project and handle IDs differ", async () => {
    const inconsistentHandle = { ...handle, project_id: "another_project" };
    const hook = renderExportHook(session(project, inconsistentHandle));
    await act(async () => hook.result.current.exportProject());
    expect(apiMocks.pickBundleFile).not.toHaveBeenCalled();
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
  });

  it("does not export when the project file and handle file differ", async () => {
    const inconsistentSession = {
      ...session(),
      projectFile: "D:\\research\\different.evidence.json"
    };
    const hook = renderExportHook(inconsistentSession);
    await act(async () => hook.result.current.exportProject());
    expect(apiMocks.pickBundleFile).not.toHaveBeenCalled();
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
  });

  it("treats picker cancellation as a quiet no-op", async () => {
    const hook = renderExportHook();
    apiMocks.pickBundleFile.mockResolvedValueOnce(null);
    await act(async () => hook.result.current.exportProject());
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.busy).toBe(false);
  });

  it("becomes busy while the native picker remains open", async () => {
    const hook = renderExportHook();
    const picker = deferred<string | null>();
    apiMocks.pickBundleFile.mockReturnValueOnce(picker.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    await act(async () => {
      picker.resolve(null);
      await operation;
    });
    expect(hook.result.current.busy).toBe(false);
  });

  it("opens the picker with the project-derived bundle name and active file", async () => {
    const hook = renderExportHook();
    apiMocks.pickBundleFile.mockResolvedValueOnce(null);
    await act(async () => hook.result.current.exportProject());
    expect(apiMocks.pickBundleFile).toHaveBeenCalledWith(
      "Export_Study_export.zip",
      handle.project_file
    );
  });

  it("submits one immutable snapshot of the captured session and preferences", async () => {
    const hook = renderExportHook();
    act(() => {
      hook.result.current.toggleProduct("docx");
      hook.result.current.setDocxMode("combined");
      hook.result.current.setIncludeLocalPaths(true);
      hook.result.current.setIncludeAiAudit(true);
    });
    const picker = deferred<string | null>();
    apiMocks.pickBundleFile.mockReturnValueOnce(picker.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    act(() => {
      hook.result.current.toggleProduct("json");
      hook.result.current.setDocxMode("separate");
      hook.result.current.setIncludeLocalPaths(false);
      hook.result.current.setIncludeAiAudit(false);
    });
    apiMocks.exportBundle.mockResolvedValueOnce(payload);
    await act(async () => {
      picker.resolve("D:\\exports\\requested.zip");
      await operation;
    });
    expect(apiMocks.exportBundle).toHaveBeenCalledWith({
      handle,
      output_file: "D:\\exports\\requested.zip",
      products: ["xlsx", "docx"],
      docx_mode: "combined",
      include_local_paths: true,
      include_ai_audit: true
    });
  });

  it("publishes the bundle, artifacts, warnings, and established completion message", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    expect(hook.result.current.bundlePath).toBe(payload.bundle.path);
    expect(hook.result.current.artifacts).toEqual(payload.artifacts);
    expect(hook.result.current.warnings).toEqual(payload.warnings);
    expect(hook.result.current.status).toBe("Created Export_Study_export.zip with 1 contained file(s).");
    expect(hook.result.current.error).toBeNull();
  });

  it("reports a current export failure locally", async () => {
    const hook = renderExportHook();
    apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\requested.zip");
    apiMocks.exportBundle.mockRejectedValueOnce(new Error("Bundle failed."));
    await act(async () => hook.result.current.exportProject());
    expect(hook.result.current.error).toBe("Bundle failed.");
    expect(hook.result.current.bundlePath).toBe("");
  });

  it("rejects a destination without a parent directory", async () => {
    const hook = renderExportHook();
    apiMocks.pickBundleFile.mockResolvedValueOnce("requested.zip");
    await act(async () => hook.result.current.exportProject());
    expect(hook.result.current.error).toBe("Choose a valid output file location.");
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
  });

  it("opens the folder belonging to the visible export result", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    await act(async () => hook.result.current.openOutputFolder());
    expect(apiMocks.openPath).toHaveBeenCalledWith({
      path: "D:\\exports",
      expect_directory: true,
      create_if_missing: false
    });
  });

  it("retains the result when opening its output folder fails", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    apiMocks.openPath.mockRejectedValueOnce(new Error("Folder unavailable."));
    await act(async () => hook.result.current.openOutputFolder());
    expect(hook.result.current.error).toBe("Folder unavailable.");
    expect(hook.result.current.bundlePath).toBe(payload.bundle.path);
  });

  it("silences a late output-folder failure after an exact session change", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    const pendingOpen = deferred<void>();
    apiMocks.openPath.mockReturnValueOnce(pendingOpen.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.openOutputFolder(); });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));

    act(() => hook.replaceSession(session(project, { ...handle, revision: "b".repeat(64) })));
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.bundlePath).toBe("");
    await act(async () => {
      pendingOpen.reject(new Error("Obsolete folder failure."));
      await operation;
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.bundlePath).toBe("");
  });

  it("silences a reset folder failure without clearing a newer result", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    const pendingOpen = deferred<void>();
    apiMocks.openPath.mockReturnValueOnce(pendingOpen.promise);
    let folderOperation!: Promise<void>;
    act(() => { folderOperation = hook.result.current.openOutputFolder(); });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));

    act(() => hook.result.current.reset());
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.bundlePath).toBe("");
    const newerPayload = {
      ...payload,
      bundle: { ...payload.bundle, path: "D:\\exports\\newer.zip" }
    };
    apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\newer.zip");
    apiMocks.exportBundle.mockResolvedValueOnce(newerPayload);
    await act(async () => hook.result.current.exportProject());
    expect(hook.result.current.bundlePath).toBe("D:\\exports\\newer.zip");

    await act(async () => {
      pendingOpen.reject(new Error("Obsolete folder failure."));
      await folderOperation;
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.bundlePath).toBe("D:\\exports\\newer.zip");
  });

  it("clears results and privacy options for a different logical project", async () => {
    const hook = renderExportHook();
    act(() => {
      hook.result.current.toggleProduct("docx");
      hook.result.current.setDocxMode("combined");
      hook.result.current.setIncludeLocalPaths(true);
      hook.result.current.setIncludeAiAudit(true);
    });
    await completeExport(hook);
    const replacement = { ...project, project_id: "replacement" };
    const replacementHandle = {
      ...handle,
      project_id: replacement.project_id,
      project_file: "D:\\research\\replacement.evidence.json"
    };
    act(() => hook.replaceSession(session(replacement, replacementHandle)));
    expect(hook.result.current.bundlePath).toBe("");
    expect(hook.result.current.includeLocalPaths).toBe(false);
    expect(hook.result.current.includeAiAudit).toBe(false);
    expect(hook.result.current.products).toEqual(["xlsx", "docx"]);
    expect(hook.result.current.docxMode).toBe("combined");
  });

  it("clears results and privacy options when the project closes", async () => {
    const hook = renderExportHook();
    act(() => hook.result.current.setIncludeAiAudit(true));
    await completeExport(hook);
    act(() => hook.replaceSession(session(null, null)));
    expect(hook.result.current.bundlePath).toBe("");
    expect(hook.result.current.includeAiAudit).toBe(false);
  });

  it("invalidates results on Save As while retaining privacy preferences", async () => {
    const hook = renderExportHook();
    act(() => hook.result.current.setIncludeLocalPaths(true));
    await completeExport(hook);
    act(() => hook.replaceSession(session(project, {
      ...handle,
      project_file: "D:\\research\\copy.evidence.json",
      revision: "b".repeat(64)
    })));
    expect(hook.result.current.bundlePath).toBe("");
    expect(hook.result.current.includeLocalPaths).toBe(true);
  });

  it("invalidates results when the active project revision changes", async () => {
    const hook = renderExportHook();
    await completeExport(hook);
    act(() => hook.replaceSession(session(project, { ...handle, revision: "b".repeat(64) })));
    expect(hook.result.current.bundlePath).toBe("");
    expect(hook.result.current.status).toBe("");
  });

  it("ignores a picker result after project replacement", async () => {
    const hook = renderExportHook();
    const picker = deferred<string | null>();
    apiMocks.pickBundleFile.mockReturnValueOnce(picker.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    act(() => hook.replaceSession(session(
      { ...project, project_id: "replacement" },
      { ...handle, project_id: "replacement", project_file: "D:\\research\\replacement.evidence.json" }
    )));
    await act(async () => {
      picker.resolve("D:\\exports\\stale.zip");
      await operation;
    });
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
  });

  it("ignores a successful response from an obsolete revision", async () => {
    const hook = renderExportHook();
    const pending = deferred<CodesExportBundlePayload>();
    apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\stale.zip");
    apiMocks.exportBundle.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    await waitFor(() => expect(apiMocks.exportBundle).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(project, { ...handle, revision: "b".repeat(64) })));
    await act(async () => {
      pending.resolve(payload);
      await operation;
    });
    expect(hook.result.current.bundlePath).toBe("");
  });

  it("does not publish a rejected response from an obsolete session", async () => {
    const hook = renderExportHook();
    const pending = deferred<CodesExportBundlePayload>();
    apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\stale.zip");
    apiMocks.exportBundle.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    await waitFor(() => expect(apiMocks.exportBundle).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(project, { ...handle, revision: "b".repeat(64) })));
    await act(async () => {
      pending.reject(new Error("Obsolete failure."));
      await operation;
    });
    expect(hook.result.current.error).toBeNull();
  });

  it("explicit reset invalidates pending work and restores privacy defaults", async () => {
    const hook = renderExportHook();
    const picker = deferred<string | null>();
    apiMocks.pickBundleFile.mockReturnValueOnce(picker.promise);
    act(() => hook.result.current.setIncludeAiAudit(true));
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    act(() => hook.result.current.reset());
    await act(async () => {
      picker.resolve("D:\\exports\\stale.zip");
      await operation;
    });
    expect(apiMocks.exportBundle).not.toHaveBeenCalled();
    expect(hook.result.current.includeAiAudit).toBe(false);
    expect(hook.result.current.busy).toBe(false);
  });

  it("publishes only the newest overlapping export", async () => {
    const hook = renderExportHook();
    const first = deferred<CodesExportBundlePayload>();
    const second = deferred<CodesExportBundlePayload>();
    apiMocks.pickBundleFile
      .mockResolvedValueOnce("D:\\exports\\first.zip")
      .mockResolvedValueOnce("D:\\exports\\second.zip");
    apiMocks.exportBundle
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let firstOperation!: Promise<void>;
    act(() => { firstOperation = hook.result.current.exportProject(); });
    await waitFor(() => expect(apiMocks.exportBundle).toHaveBeenCalledTimes(1));
    let secondOperation!: Promise<void>;
    act(() => { secondOperation = hook.result.current.exportProject(); });
    await waitFor(() => expect(apiMocks.exportBundle).toHaveBeenCalledTimes(2));
    const newestPayload = {
      ...payload,
      bundle: { ...payload.bundle, path: "D:\\exports\\second.zip" }
    };
    await act(async () => {
      second.resolve(newestPayload);
      await secondOperation;
      first.resolve(payload);
      await firstOperation;
    });
    expect(hook.result.current.bundlePath).toBe("D:\\exports\\second.zip");
    expect(hook.result.current.busy).toBe(false);
  });

  it("does not publish after unmount", async () => {
    const hook = renderExportHook();
    const pending = deferred<CodesExportBundlePayload>();
    apiMocks.pickBundleFile.mockResolvedValueOnce("D:\\exports\\pending.zip");
    apiMocks.exportBundle.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.exportProject(); });
    await waitFor(() => expect(apiMocks.exportBundle).toHaveBeenCalledTimes(1));
    hook.unmount();
    await act(async () => {
      pending.resolve(payload);
      await operation;
    });
    expect(apiMocks.exportBundle).toHaveBeenCalledTimes(1);
  });
});
