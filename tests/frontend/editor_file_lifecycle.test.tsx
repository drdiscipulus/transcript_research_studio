import { StrictMode, useMemo, useRef } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorDocumentWorkspace } from "../../src/hooks/useEditorDocumentWorkspace";
import { useEditorFileLifecycle } from "../../src/hooks/useEditorFileLifecycle";
import type { EditorTranscript } from "../../src/lib/api";

const apiMocks = vi.hoisted(() => ({
  exportEditorTranscript: vi.fn(),
  inspectEditorTranscript: vi.fn(),
  loadEditorTranscript: vi.fn(),
  openPath: vi.fn(),
  pickEditorExportFile: vi.fn(),
  pickMediaFile: vi.fn(),
  pickSaveFile: vi.fn(),
  pickTranscriptFile: vi.fn(),
  saveEditorTranscript: vi.fn()
}));

vi.mock("../../src/lib/api", () => apiMocks);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeTranscript(source = "C:\\research\\interview.json", id = "one"): EditorTranscript {
  return {
    source_transcript_file: source,
    source_document_id: id,
    media_file: "",
    language: "en",
    speakers: [{ id: "SPEAKER_00", name: "Speaker" }],
    segments: [{ id: "seg_000001", start: 0, end: 10, speaker: "SPEAKER_00", text: `Transcript ${id}` }],
    metadata: {},
    validation_issues: []
  };
}

function useHarness(workspaceLock?: { current: boolean }) {
  const coordinatorRef = useRef<{ isLocked: () => boolean; publishDocumentStatus: (message: string) => void } | null>(null);
  const document = useEditorDocumentWorkspace({
    isOperationLocked: () => coordinatorRef.current?.isLocked() ?? false,
    publishStatus: (message) => coordinatorRef.current?.publishDocumentStatus(message)
  });
  const bridge = useMemo(() => ({
    getSnapshot: document.getSnapshot,
    snapshotIsCurrent: document.snapshotIsCurrent,
    applyLoadedDocument: document.applyLoadedDocument,
    applySuccessfulSave: document.applySuccessfulSave,
    applyExportValidation: document.applyExportValidation,
    applyMediaFromLifecycle: document.applyMediaFromLifecycle,
    clearDocument: document.clearDocument
  }), [
    document.applyExportValidation,
    document.applyLoadedDocument,
    document.applyMediaFromLifecycle,
    document.applySuccessfulSave,
    document.clearDocument,
    document.getSnapshot,
    document.snapshotIsCurrent
  ]);
  const file = useEditorFileLifecycle({
    document: bridge,
    isWorkspaceOperationLocked: () => workspaceLock?.current ?? false
  });
  coordinatorRef.current = file;
  return { document, file };
}

async function selectSource(result: ReturnType<typeof renderHook<ReturnType<typeof useHarness>, unknown>>["result"]) {
  await act(async () => {
    await result.current.file.pickTranscript();
  });
}

describe("useEditorFileLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\interview.json");
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [{ id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 }],
      requires_document_selection: false
    });
    apiMocks.loadEditorTranscript.mockResolvedValue(makeTranscript());
    apiMocks.pickMediaFile.mockResolvedValue("C:\\research\\interview.mp4");
    apiMocks.pickSaveFile.mockResolvedValue("C:\\research\\interview.editing.json");
    apiMocks.saveEditorTranscript.mockResolvedValue({
      output_file: "C:\\research\\interview.editing.json",
      validation_issues: []
    });
    apiMocks.pickEditorExportFile.mockResolvedValue("C:\\research\\interview_edited.xlsx");
    apiMocks.exportEditorTranscript.mockResolvedValue({
      output_files: [{ format: "xlsx", path: "C:\\research\\interview_edited.xlsx", exists: true }],
      validation_issues: []
    });
    apiMocks.openPath.mockResolvedValue({ opened_path: "C:\\research" });
  });

  it("acquires the operation lock synchronously before opening a picker and releases it on cancel", async () => {
    const picker = deferred<string | null>();
    apiMocks.pickTranscriptFile.mockReturnValue(picker.promise);
    const { result } = renderHook(() => useHarness());

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.file.pickTranscript();
    });
    expect(result.current.file.busy).toBe(true);
    expect(result.current.file.activityLabel).toBe("Choosing transcript");
    await expect(result.current.file.pickTranscript()).resolves.toBe(false);

    await act(async () => {
      picker.resolve(null);
      await pending;
    });
    expect(result.current.file.busy).toBe(false);
    expect(result.current.file.transcriptFile).toBe("");
  });

  it("loads a single inspected document automatically", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => {
      expect(await result.current.file.inspectAndLoadTranscript()).toBe(true);
    });
    expect(apiMocks.loadEditorTranscript).toHaveBeenCalledWith("C:\\research\\interview.json", "one");
    expect(result.current.file.editorMode).toBe("editing");
    expect(result.current.document.transcript?.source_document_id).toBe("one");
  });

  it("requires an explicit choice for multiple documents and loads only the selected ID", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "edited-json",
      documents: [
        { id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 },
        { id: "two", label: "Two", file_name: "two.m4a", segment_count: 1, duration: 20 }
      ],
      requires_document_selection: true
    });
    apiMocks.loadEditorTranscript.mockImplementation(async (_path: string, id: string) => makeTranscript("C:\\research\\interview.json", id));
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => {
      expect(await result.current.file.inspectAndLoadTranscript()).toBe(false);
    });
    expect(apiMocks.loadEditorTranscript).not.toHaveBeenCalled();
    expect(result.current.file.documentSelection?.documents).toHaveLength(2);
    expect(result.current.file.busy).toBe(true);

    const selection = result.current.file.documentSelection;
    expect(selection).not.toBeNull();
    act(() => expect(result.current.file.chooseDocument(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1,
      "two"
    )).toBe(true));
    await act(async () => {
      expect(await result.current.file.confirmDocumentSelection(
        selection?.operationId ?? -1,
        selection?.lifecycleGeneration ?? -1
      )).toBe(true);
    });
    expect(apiMocks.loadEditorTranscript).toHaveBeenCalledWith("C:\\research\\interview.json", "two");
    expect(result.current.document.transcript?.source_document_id).toBe("two");
    expect(result.current.file.savePath).toBe("C:\\research\\interview.json");
  });

  it("cancels document selection without loading and clears the pending lock", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [
        { id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 },
        { id: "two", label: "Two", file_name: "two.m4a", segment_count: 1, duration: 20 }
      ],
      requires_document_selection: true
    });
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => {
      await result.current.file.inspectAndLoadTranscript();
    });
    const selection = result.current.file.documentSelection;
    act(() => result.current.file.cancelDocumentSelection(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1
    ));
    expect(result.current.file.documentSelection).toBeNull();
    expect(result.current.file.busy).toBe(false);
    expect(apiMocks.loadEditorTranscript).not.toHaveBeenCalled();
  });

  it("starts a selected-document load exactly once and makes Cancel invalidate its late result", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [
        { id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 },
        { id: "two", label: "Two", file_name: "two.m4a", segment_count: 1, duration: 20 }
      ],
      requires_document_selection: true
    });
    const loadRequest = deferred<EditorTranscript>();
    apiMocks.loadEditorTranscript.mockReturnValue(loadRequest.promise);
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    const selection = result.current.file.documentSelection;
    expect(selection).not.toBeNull();
    act(() => expect(result.current.file.chooseDocument(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1,
      "two"
    )).toBe(true));

    let firstLoad!: Promise<boolean>;
    let repeatedLoad!: Promise<boolean>;
    act(() => {
      firstLoad = result.current.file.confirmDocumentSelection(
        selection?.operationId ?? -1,
        selection?.lifecycleGeneration ?? -1
      );
      repeatedLoad = result.current.file.confirmDocumentSelection(
        selection?.operationId ?? -1,
        selection?.lifecycleGeneration ?? -1
      );
    });
    await expect(repeatedLoad).resolves.toBe(false);
    expect(apiMocks.loadEditorTranscript).toHaveBeenCalledTimes(1);
    expect(result.current.file.documentSelection?.loading).toBe(true);

    act(() => expect(result.current.file.cancelDocumentSelection(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1
    )).toBe(true));
    await act(async () => {
      loadRequest.resolve(makeTranscript("C:\\research\\interview.json", "two"));
      expect(await firstLoad).toBe(false);
    });
    expect(result.current.document.transcript).toBeNull();
    expect(result.current.file.documentSelection).toBeNull();
    expect(result.current.file.errorMessage).toBeNull();
    expect(result.current.file.busy).toBe(false);
  });

  it("rejects retained selection callbacks after a newer document chooser replaces them", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [
        { id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 },
        { id: "two", label: "Two", file_name: "two.m4a", segment_count: 1, duration: 20 }
      ],
      requires_document_selection: true
    });
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    const oldSelection = result.current.file.documentSelection;
    act(() => result.current.file.cancelDocumentSelection(
      oldSelection?.operationId ?? -1,
      oldSelection?.lifecycleGeneration ?? -1
    ));

    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    const currentSelection = result.current.file.documentSelection;
    expect(currentSelection?.operationId).not.toBe(oldSelection?.operationId);
    expect(result.current.file.chooseDocument(
      oldSelection?.operationId ?? -1,
      oldSelection?.lifecycleGeneration ?? -1,
      "two"
    )).toBe(false);
    expect(result.current.file.cancelDocumentSelection(
      oldSelection?.operationId ?? -1,
      oldSelection?.lifecycleGeneration ?? -1
    )).toBe(false);
    expect(result.current.file.documentSelection?.operationId).toBe(currentSelection?.operationId);

    act(() => result.current.file.cancelDocumentSelection(
      currentSelection?.operationId ?? -1,
      currentSelection?.lifecycleGeneration ?? -1
    ));
  });

  it("reports an empty inspection safely and rejects stale document choices", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValueOnce({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [],
      requires_document_selection: false
    }).mockResolvedValueOnce({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [
        { id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 },
        { id: "two", label: "Two", file_name: "two.m4a", segment_count: 1, duration: 20 }
      ],
      requires_document_selection: true
    });
    const { result } = renderHook(() => useHarness());
    await selectSource(result);

    await act(async () => {
      expect(await result.current.file.inspectAndLoadTranscript()).toBe(false);
    });
    expect(result.current.file.statusMessage).toBe("No editable transcript was found in the selected file.");
    expect(apiMocks.loadEditorTranscript).not.toHaveBeenCalled();

    await act(async () => {
      expect(await result.current.file.inspectAndLoadTranscript()).toBe(false);
    });
    const selection = result.current.file.documentSelection;
    expect(result.current.file.chooseDocument(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1,
      "not-present"
    )).toBe(false);
    expect(result.current.file.chooseDocument(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1,
      "two"
    )).toBe(true);
    act(() => result.current.file.cancelDocumentSelection(
      selection?.operationId ?? -1,
      selection?.lifecycleGeneration ?? -1
    ));
    await act(async () => {
      expect(await result.current.file.confirmDocumentSelection(
        selection?.operationId ?? -1,
        selection?.lifecycleGeneration ?? -1
      )).toBe(false);
    });
    expect(result.current.file.documentSelection).toBeNull();
    expect(apiMocks.loadEditorTranscript).not.toHaveBeenCalled();
  });

  it("retains an unsaved document until source replacement is explicitly confirmed", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Unsaved" }));
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\replacement.json");

    await act(async () => { await result.current.file.pickTranscript(); });
    expect(result.current.file.sourceReplacement?.selectedPath).toBe("C:\\research\\replacement.json");
    expect(result.current.document.transcript?.segments[0].text).toBe("Unsaved");
    expect(result.current.file.busy).toBe(true);

    const replacement = result.current.file.sourceReplacement;
    expect(replacement).not.toBeNull();
    act(() => expect(result.current.file.confirmSourceReplacement(
      replacement?.operationId ?? -1,
      replacement?.lifecycleGeneration ?? -1
    )).toBe(true));
    expect(result.current.file.confirmSourceReplacement(
      replacement?.operationId ?? -1,
      replacement?.lifecycleGeneration ?? -1
    )).toBe(false);
    expect(result.current.document.transcript).toBeNull();
    expect(result.current.file.transcriptFile).toBe("C:\\research\\replacement.json");
    expect(result.current.file.busy).toBe(false);
  });

  it("cancels source replacement without changing the loaded draft or selected path", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Keep this draft" }));
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\replacement.json");

    await act(async () => { await result.current.file.pickTranscript(); });
    const replacement = result.current.file.sourceReplacement;
    act(() => result.current.file.cancelSourceReplacement(
      replacement?.operationId ?? -1,
      replacement?.lifecycleGeneration ?? -1
    ));

    expect(result.current.file.transcriptFile).toBe("C:\\research\\interview.json");
    expect(result.current.document.transcript?.segments[0].text).toBe("Keep this draft");
    expect(result.current.document.dirty).toBe(true);
    expect(result.current.file.sourceReplacement).toBeNull();
    expect(result.current.file.busy).toBe(false);
  });

  it("keeps document, baseline, path, and dirty state when Save As is cancelled", async () => {
    apiMocks.pickSaveFile.mockResolvedValue(null);
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Unsaved" }));
    const before = result.current.document.getSnapshot();

    await act(async () => {
      expect(await result.current.file.saveWorkingCopy(true)).toBe(false);
    });
    expect(result.current.document.transcript).toBe(before.transcript);
    expect(result.current.document.baselineTranscript).toBe(before.baselineTranscript);
    expect(result.current.document.dirty).toBe(true);
    expect(result.current.file.savePath).toBe("");
  });

  it("uses the active editing-copy path for Save without reopening the picker", async () => {
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "edited-json",
      documents: [{ id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 }],
      requires_document_selection: false
    });
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Saved through active path" }));
    apiMocks.pickSaveFile.mockClear();

    await act(async () => {
      expect(await result.current.file.saveWorkingCopy(false)).toBe(true);
    });

    expect(apiMocks.pickSaveFile).not.toHaveBeenCalled();
    expect(apiMocks.saveEditorTranscript).toHaveBeenCalledWith(
      "C:\\research\\interview.json",
      expect.objectContaining({
        segments: [expect.objectContaining({ text: "Saved through active path" })]
      })
    );
    expect(result.current.document.dirty).toBe(false);
  });

  it("applies the external workspace lock to every public file action including same-source Open", async () => {
    const workspaceLock = { current: false };
    const { result } = renderHook(() => useHarness(workspaceLock));
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    expect(result.current.file.closeEditor()).toBe(true);
    vi.clearAllMocks();
    workspaceLock.current = true;

    await expect(result.current.file.pickTranscript()).resolves.toBe(false);
    expect(result.current.file.clearTranscript()).toBe(false);
    await expect(result.current.file.inspectAndLoadTranscript()).resolves.toBe(false);
    await expect(result.current.file.pickMedia()).resolves.toBe(false);
    expect(result.current.file.clearMedia()).toBe(false);
    await expect(result.current.file.saveWorkingCopy(false)).resolves.toBe(false);
    expect(result.current.file.setExportFormats(["json"])).toBe(false);
    await expect(result.current.file.exportTranscript()).resolves.toBe(false);
    await expect(result.current.file.openTranscript()).resolves.toBe(false);
    expect(result.current.file.closeEditor()).toBe(false);

    expect(apiMocks.pickTranscriptFile).not.toHaveBeenCalled();
    expect(apiMocks.inspectEditorTranscript).not.toHaveBeenCalled();
    expect(apiMocks.pickMediaFile).not.toHaveBeenCalled();
    expect(apiMocks.saveEditorTranscript).not.toHaveBeenCalled();
    expect(apiMocks.exportEditorTranscript).not.toHaveBeenCalled();
    expect(apiMocks.openPath).not.toHaveBeenCalled();
  });

  it("treats cancelled media and export pickers as silent no-ops", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Remain dirty" }));
    const priorStatus = result.current.file.statusMessage;
    apiMocks.pickMediaFile.mockResolvedValue(null);
    apiMocks.pickEditorExportFile.mockResolvedValue(null);

    await act(async () => {
      expect(await result.current.file.pickMedia()).toBe(false);
      expect(await result.current.file.exportTranscript()).toBe(false);
    });

    expect(result.current.document.transcript?.media_file).toBe("");
    expect(result.current.document.dirty).toBe(true);
    expect(result.current.file.lastExportFiles).toEqual([]);
    expect(result.current.file.statusMessage).toBe(priorStatus);
    expect(result.current.file.errorMessage).toBeNull();
  });

  it("ignores stale media and Save results after authoritative document replacement", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });

    const mediaPicker = deferred<string | null>();
    apiMocks.pickMediaFile.mockReturnValue(mediaPicker.promise);
    let mediaOperation!: Promise<boolean>;
    act(() => { mediaOperation = result.current.file.pickMedia(); });
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\replacement.json", "replacement")));
    await act(async () => {
      mediaPicker.resolve("C:\\research\\stale.mp4");
      await mediaOperation;
    });
    expect(result.current.document.transcript?.media_file).toBe("");
    expect(result.current.file.busy).toBe(false);

    act(() => result.current.document.updateSegment(0, { text: "Save me" }));
    const saveRequest = deferred<{ output_file: string; validation_issues: [] }>();
    apiMocks.saveEditorTranscript.mockReturnValue(saveRequest.promise);
    let saveOperation!: Promise<boolean>;
    act(() => { saveOperation = result.current.file.saveWorkingCopy(true); });
    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalled());
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\newer.json", "newer")));
    await act(async () => {
      saveRequest.resolve({ output_file: "C:\\research\\stale.json", validation_issues: [] });
      await saveOperation;
    });
    expect(result.current.document.transcript?.source_document_id).toBe("newer");
    expect(result.current.file.savePath).toBe("");
    expect(result.current.file.busy).toBe(false);
  });

  it("suppresses stale inspect, load, Save, export, and open-path failures", async () => {
    const { result } = renderHook(() => useHarness());
    await selectSource(result);

    const inspectRequest = deferred<never>();
    apiMocks.inspectEditorTranscript.mockReturnValueOnce(inspectRequest.promise);
    let inspectOperation!: Promise<boolean>;
    act(() => { inspectOperation = result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\newer.json", "newer")));
    await act(async () => {
      inspectRequest.reject(new Error("obsolete inspect"));
      expect(await inspectOperation).toBe(false);
    });
    expect(result.current.file.errorMessage).toBeNull();

    act(() => result.current.document.clearDocument());
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [{ id: "one", label: "One", file_name: "one.m4a", segment_count: 1, duration: 10 }],
      requires_document_selection: false
    });
    const loadRequest = deferred<EditorTranscript>();
    apiMocks.loadEditorTranscript.mockReturnValueOnce(loadRequest.promise);
    let loadOperation!: Promise<boolean>;
    act(() => { loadOperation = result.current.file.inspectAndLoadTranscript(); });
    await waitFor(() => expect(apiMocks.loadEditorTranscript).toHaveBeenCalled());
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\replacement.json", "replacement")));
    await act(async () => {
      loadRequest.reject(new Error("obsolete load"));
      expect(await loadOperation).toBe(false);
    });
    expect(result.current.file.errorMessage).toBeNull();

    act(() => result.current.document.updateSegment(0, { text: "Save snapshot" }));
    const saveRequest = deferred<never>();
    apiMocks.saveEditorTranscript.mockReturnValueOnce(saveRequest.promise);
    let saveOperation!: Promise<boolean>;
    act(() => { saveOperation = result.current.file.saveWorkingCopy(true); });
    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalled());
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\latest.json", "latest")));
    await act(async () => {
      saveRequest.reject(new Error("obsolete save"));
      expect(await saveOperation).toBe(false);
    });
    expect(result.current.file.errorMessage).toBeNull();

    const exportRequest = deferred<never>();
    apiMocks.exportEditorTranscript.mockReturnValueOnce(exportRequest.promise);
    let exportOperation!: Promise<boolean>;
    act(() => { exportOperation = result.current.file.exportTranscript(); });
    await waitFor(() => expect(apiMocks.exportEditorTranscript).toHaveBeenCalled());
    act(() => result.current.document.applyLoadedDocument(makeTranscript("C:\\research\\final.json", "final")));
    await act(async () => {
      exportRequest.reject(new Error("obsolete export"));
      expect(await exportOperation).toBe(false);
    });
    expect(result.current.file.errorMessage).toBeNull();
    expect(result.current.file.lastExportFiles).toEqual([]);

    expect(result.current.file.busy).toBe(false);
  });

  it("suppresses a retained open-path failure after the workspace unmounts", async () => {
    const openRequest = deferred<never>();
    apiMocks.openPath.mockReturnValueOnce(openRequest.promise);
    const { result, unmount } = renderHook(() => useHarness());
    await selectSource(result);
    let openOperation!: Promise<boolean>;
    act(() => { openOperation = result.current.file.openTranscript(); });
    unmount();
    await act(async () => {
      openRequest.reject(new Error("obsolete open"));
      expect(await openOperation).toBe(false);
    });
  });

  it("keeps export dirty and ignores late results after unmount under Strict Mode", async () => {
    const request = deferred<{ output_files: []; validation_issues: [] }>();
    apiMocks.exportEditorTranscript.mockReturnValue(request.promise);
    const { result, unmount } = renderHook(() => useHarness(), { wrapper: StrictMode });
    await selectSource(result);
    await act(async () => { await result.current.file.inspectAndLoadTranscript(); });
    act(() => result.current.document.updateSegment(0, { text: "Unsaved export" }));
    let operation!: Promise<boolean>;
    act(() => { operation = result.current.file.exportTranscript(); });
    await waitFor(() => expect(apiMocks.exportEditorTranscript).toHaveBeenCalled());
    unmount();
    await act(async () => {
      request.resolve({ output_files: [], validation_issues: [] });
      await operation;
    });
    expect(apiMocks.exportEditorTranscript).toHaveBeenCalledWith(expect.objectContaining({
      transcript: expect.objectContaining({
        segments: [expect.objectContaining({ text: "Unsaved export" })]
      }),
      export_formats: ["xlsx"]
    }));
  });
});
