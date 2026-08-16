import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  exportEditorTranscript,
  inspectEditorTranscript,
  loadEditorTranscript,
  openPath,
  pickEditorExportFile,
  pickMediaFile,
  pickSaveFile,
  pickTranscriptFile,
  saveEditorTranscript,
  type EditorDocumentChoice,
  type EditorTranscript,
  type EditorValidationIssue,
  type PreparedExport
} from "../lib/api";
import {
  fileName,
  fileStem,
  folderName,
  normalizePath
} from "../lib/editorState";
import type { EditorDocumentSnapshot } from "./useEditorDocumentWorkspace";

type EditorMode = "setup" | "editing";

type EditorFileOperationKind =
  | "pick-transcript"
  | "inspect-transcript"
  | "load-transcript"
  | "pick-media"
  | "save"
  | "export"
  | "open-path"
  | "replace-source";

type EditorFileOperation = {
  id: number;
  kind: EditorFileOperationKind;
  label: string;
  lifecycleGeneration: number;
};

type EditorSourceReplacementConfirmation = {
  action: "select" | "clear";
  selectedPath: string;
  documentGeneration: number;
  editRevision: number;
  operationId: number;
  lifecycleGeneration: number;
};

type EditorDocumentSelection = {
  inspectedPath: string;
  format: string;
  documents: EditorDocumentChoice[];
  selectedDocumentId: string;
  operationId: number;
  lifecycleGeneration: number;
  documentSnapshot: EditorDocumentSnapshot;
  loading: boolean;
};

type EditorDocumentLifecycleBridge = {
  getSnapshot: () => EditorDocumentSnapshot;
  snapshotIsCurrent: (snapshot: EditorDocumentSnapshot) => boolean;
  applyLoadedDocument: (loaded: EditorTranscript, proposedMediaFile?: string) => EditorTranscript;
  applySuccessfulSave: (snapshot: EditorDocumentSnapshot, issues: EditorValidationIssue[]) => boolean;
  applyExportValidation: (snapshot: EditorDocumentSnapshot, issues: EditorValidationIssue[]) => boolean;
  applyMediaFromLifecycle: (snapshot: EditorDocumentSnapshot, mediaFile: string) => boolean;
  clearDocument: () => void;
};

type UseEditorFileLifecycleOptions = {
  document: EditorDocumentLifecycleBridge;
  isWorkspaceOperationLocked?: () => boolean;
};

const DEFAULT_STATUS = "Load a transcript export or saved editing copy to begin editing.";

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function useEditorFileLifecycle({
  document,
  isWorkspaceOperationLocked = () => false
}: UseEditorFileLifecycleOptions) {
  const [editorMode, setEditorMode] = useState<EditorMode>("setup");
  const [transcriptFile, setTranscriptFile] = useState("");
  const [proposedMediaFile, setProposedMediaFile] = useState("");
  const [savePath, setSavePath] = useState("");
  const [exportFolder, setExportFolder] = useState("");
  const [exportName, setExportName] = useState("");
  const [exportFormats, setExportFormatsState] = useState<string[]>(["xlsx"]);
  const [lastExportFiles, setLastExportFiles] = useState<PreparedExport[]>([]);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<EditorFileOperation | null>(null);
  const [sourceReplacement, setSourceReplacement] = useState<EditorSourceReplacementConfirmation | null>(null);
  const [documentSelection, setDocumentSelection] = useState<EditorDocumentSelection | null>(null);

  const mountedRef = useRef(false);
  const operationSequenceRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const activeOperationRef = useRef<EditorFileOperation | null>(null);
  const transcriptFileRef = useRef("");
  const proposedMediaFileRef = useRef("");
  const savePathRef = useRef("");
  const exportFolderRef = useRef("");
  const exportNameRef = useRef("");
  const exportFormatsRef = useRef<string[]>(["xlsx"]);
  const lastExportFilesRef = useRef<PreparedExport[]>([]);
  const sourceReplacementRef = useRef<EditorSourceReplacementConfirmation | null>(null);
  const documentSelectionRef = useRef<EditorDocumentSelection | null>(null);
  const workspaceLockRef = useRef(isWorkspaceOperationLocked);
  workspaceLockRef.current = isWorkspaceOperationLocked;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      activeOperationRef.current = null;
      sourceReplacementRef.current = null;
      documentSelectionRef.current = null;
    };
  }, []);

  const syncTranscriptFile = useCallback((next: string) => {
    transcriptFileRef.current = next;
    setTranscriptFile(next);
  }, []);

  const syncProposedMedia = useCallback((next: string) => {
    proposedMediaFileRef.current = next;
    setProposedMediaFile(next);
  }, []);

  const syncSavePath = useCallback((next: string) => {
    savePathRef.current = next;
    setSavePath(next);
  }, []);

  const syncExportFolder = useCallback((next: string) => {
    exportFolderRef.current = next;
    setExportFolder(next);
  }, []);

  const syncExportName = useCallback((next: string) => {
    exportNameRef.current = next;
    setExportName(next);
  }, []);

  const syncExportFiles = useCallback((next: PreparedExport[]) => {
    lastExportFilesRef.current = next;
    setLastExportFiles(next);
  }, []);

  const syncSourceReplacement = useCallback((next: EditorSourceReplacementConfirmation | null) => {
    sourceReplacementRef.current = next;
    setSourceReplacement(next);
  }, []);

  const syncDocumentSelection = useCallback((next: EditorDocumentSelection | null) => {
    documentSelectionRef.current = next;
    setDocumentSelection(next);
  }, []);

  const isLocked = useCallback(() => (
    activeOperationRef.current !== null || workspaceLockRef.current()
  ), []);

  const beginOperation = useCallback((kind: EditorFileOperationKind, label: string): EditorFileOperation | null => {
    if (isLocked() || !mountedRef.current) {
      return null;
    }
    operationSequenceRef.current += 1;
    const operation = {
      id: operationSequenceRef.current,
      kind,
      label,
      lifecycleGeneration: lifecycleGenerationRef.current
    };
    activeOperationRef.current = operation;
    setActiveOperation(operation);
    setErrorMessage(null);
    return operation;
  }, [isLocked]);

  const operationIsCurrent = useCallback((operation: EditorFileOperation) => (
    mountedRef.current
    && activeOperationRef.current?.id === operation.id
    && operation.lifecycleGeneration === lifecycleGenerationRef.current
  ), []);

  const finishOperation = useCallback((operation: EditorFileOperation) => {
    if (activeOperationRef.current?.id !== operation.id) {
      return;
    }
    activeOperationRef.current = null;
    setActiveOperation(null);
  }, []);

  const publishDocumentStatus = useCallback((message: string) => {
    if (!mountedRef.current || isLocked()) {
      return;
    }
    setStatusMessage(message);
  }, [isLocked]);

  const applySelectedSource = useCallback((selectedPath: string) => {
    lifecycleGenerationRef.current += 1;
    syncTranscriptFile(selectedPath);
    document.clearDocument();
    syncSavePath("");
    syncExportFiles([]);
    syncDocumentSelection(null);
    setEditorMode("setup");
    if (selectedPath) {
      syncExportFolder(folderName(selectedPath));
      syncExportName(`${fileStem(selectedPath)}_edited`);
      setStatusMessage("Transcript or editing copy selected. Open it to start editing.");
    } else {
      setStatusMessage(DEFAULT_STATUS);
    }
  }, [document, syncDocumentSelection, syncExportFiles, syncExportFolder, syncExportName, syncSavePath, syncTranscriptFile]);

  const pickTranscript = useCallback(async () => {
    const operation = beginOperation("pick-transcript", "Choosing transcript");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    try {
      const selected = await pickTranscriptFile(transcriptFileRef.current || undefined);
      if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
        finishOperation(operation);
        return false;
      }
      if (!selected) {
        finishOperation(operation);
        return false;
      }
      const loadedPath = snapshot.transcript?.source_transcript_file || transcriptFileRef.current;
      if (snapshot.transcript && normalizePath(selected) === normalizePath(loadedPath)) {
        syncTranscriptFile(selected);
        setStatusMessage("Current transcript selected. Open the editor to continue editing.");
        finishOperation(operation);
        return true;
      }
      if (snapshot.dirty) {
        syncSourceReplacement({
          action: "select",
          selectedPath: selected,
          documentGeneration: snapshot.documentGeneration,
          editRevision: snapshot.editRevision,
          operationId: operation.id,
          lifecycleGeneration: operation.lifecycleGeneration
        });
        return false;
      }
      applySelectedSource(selected);
      finishOperation(operation);
      return true;
    } catch (error) {
      if (operationIsCurrent(operation) && document.snapshotIsCurrent(snapshot)) {
        setErrorMessage(safeError(error, "Transcript picker failed."));
        finishOperation(operation);
      } else {
        finishOperation(operation);
      }
      return false;
    }
  }, [applySelectedSource, beginOperation, document, finishOperation, operationIsCurrent, syncSourceReplacement, syncTranscriptFile]);

  const clearTranscript = useCallback(() => {
    const operation = beginOperation("replace-source", "Clearing transcript");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    if (snapshot.dirty) {
      syncSourceReplacement({
        action: "clear",
        selectedPath: "",
        documentGeneration: snapshot.documentGeneration,
        editRevision: snapshot.editRevision,
        operationId: operation.id,
        lifecycleGeneration: operation.lifecycleGeneration
      });
      return false;
    }
    applySelectedSource("");
    finishOperation(operation);
    return true;
  }, [applySelectedSource, beginOperation, document, finishOperation, syncSourceReplacement]);

  const cancelSourceReplacement = useCallback((operationId: number, lifecycleGeneration: number) => {
    const pending = sourceReplacementRef.current;
    const operation = activeOperationRef.current;
    if (
      !pending
      || pending.operationId !== operationId
      || pending.lifecycleGeneration !== lifecycleGeneration
    ) {
      return false;
    }
    syncSourceReplacement(null);
    if (operation?.id === pending.operationId) {
      finishOperation(operation);
    }
    return true;
  }, [finishOperation, syncSourceReplacement]);

  const confirmSourceReplacement = useCallback((operationId: number, lifecycleGeneration: number) => {
    const pending = sourceReplacementRef.current;
    const operation = activeOperationRef.current;
    if (
      !pending
      || pending.operationId !== operationId
      || pending.lifecycleGeneration !== lifecycleGeneration
    ) {
      return false;
    }
    const snapshot = document.getSnapshot();
    syncSourceReplacement(null);
    if (
      !operation
      || operation.id !== pending.operationId
      || operation.lifecycleGeneration !== pending.lifecycleGeneration
      || snapshot.documentGeneration !== pending.documentGeneration
      || snapshot.editRevision !== pending.editRevision
      || !operationIsCurrent(operation)
    ) {
      if (operation) {
        finishOperation(operation);
      }
      return false;
    }
    applySelectedSource(pending.action === "select" ? pending.selectedPath : "");
    finishOperation(operation);
    return true;
  }, [applySelectedSource, document, finishOperation, operationIsCurrent, syncSourceReplacement]);

  const loadInspectedDocument = useCallback(async (
    operation: EditorFileOperation,
    path: string,
    documentId: string | undefined,
    format: string,
    expectedDocument: EditorDocumentSnapshot
  ) => {
    if (
      !operationIsCurrent(operation)
      || normalizePath(path) !== normalizePath(transcriptFileRef.current)
      || !document.snapshotIsCurrent(expectedDocument)
    ) {
      finishOperation(operation);
      return false;
    }
    setStatusMessage("Loading transcript...");
    try {
      const loaded = await loadEditorTranscript(path, documentId);
      if (
        !operationIsCurrent(operation)
        || normalizePath(path) !== normalizePath(transcriptFileRef.current)
        || !document.snapshotIsCurrent(expectedDocument)
      ) {
        finishOperation(operation);
        return false;
      }
      const next = document.applyLoadedDocument(loaded, proposedMediaFileRef.current);
      syncProposedMedia(next.media_file || proposedMediaFileRef.current);
      syncSavePath(format === "edited-json" ? path : "");
      syncExportFiles([]);
      syncDocumentSelection(null);
      setEditorMode("editing");
      setStatusMessage(`Loaded ${loaded.segments.length} editable segments.`);
      finishOperation(operation);
      return true;
    } catch (error) {
      if (
        operationIsCurrent(operation)
        && normalizePath(path) === normalizePath(transcriptFileRef.current)
        && document.snapshotIsCurrent(expectedDocument)
      ) {
        setErrorMessage(safeError(error, "Transcript load failed."));
        setStatusMessage("Transcript could not be loaded.");
        syncDocumentSelection(null);
        finishOperation(operation);
      } else {
        finishOperation(operation);
      }
      return false;
    }
  }, [document, finishOperation, operationIsCurrent, syncDocumentSelection, syncExportFiles, syncProposedMedia, syncSavePath]);

  const inspectAndLoadTranscript = useCallback(async () => {
    const path = transcriptFileRef.current;
    if (!path) {
      return false;
    }
    const operation = beginOperation("inspect-transcript", "Inspecting transcript");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    if (snapshot.transcript && normalizePath(path) === normalizePath(snapshot.transcript.source_transcript_file || path)) {
      setEditorMode("editing");
      finishOperation(operation);
      return true;
    }
    setStatusMessage("Inspecting transcript...");
    try {
      const result = await inspectEditorTranscript(path);
      if (
        !operationIsCurrent(operation)
        || normalizePath(path) !== normalizePath(transcriptFileRef.current)
        || !document.snapshotIsCurrent(snapshot)
      ) {
        finishOperation(operation);
        return false;
      }
      syncExportFolder(folderName(path));
      syncExportName(`${fileStem(path)}_edited`);
      if (result.documents.length === 0) {
        setStatusMessage("No editable transcript was found in the selected file.");
        finishOperation(operation);
        return false;
      }
      if (result.requires_document_selection || result.documents.length > 1) {
        syncDocumentSelection({
          inspectedPath: path,
          format: result.format,
          documents: result.documents,
          selectedDocumentId: "",
          operationId: operation.id,
          lifecycleGeneration: operation.lifecycleGeneration,
          documentSnapshot: snapshot,
          loading: false
        });
        setStatusMessage("Choose the transcript to edit from the selected file.");
        return false;
      }
      const [onlyDocument] = result.documents;
      return await loadInspectedDocument(operation, path, onlyDocument.id, result.format, snapshot);
    } catch (error) {
      if (
        operationIsCurrent(operation)
        && normalizePath(path) === normalizePath(transcriptFileRef.current)
        && document.snapshotIsCurrent(snapshot)
      ) {
        setErrorMessage(safeError(error, "Transcript inspection failed."));
        setStatusMessage("Transcript could not be inspected.");
        finishOperation(operation);
      } else {
        finishOperation(operation);
      }
      return false;
    }
  }, [beginOperation, document, finishOperation, loadInspectedDocument, operationIsCurrent, syncDocumentSelection, syncExportFolder, syncExportName]);

  const chooseDocument = useCallback((
    operationId: number,
    lifecycleGeneration: number,
    documentId: string
  ) => {
    const pending = documentSelectionRef.current;
    const operation = activeOperationRef.current;
    if (
      !pending
      || pending.loading
      || pending.operationId !== operationId
      || pending.lifecycleGeneration !== lifecycleGeneration
      || !pending.documents.some((documentChoice) => documentChoice.id === documentId)
      || !operation
      || pending.operationId !== operation.id
      || !operationIsCurrent(operation)
    ) {
      return false;
    }
    const next = { ...pending, selectedDocumentId: documentId };
    syncDocumentSelection(next);
    return true;
  }, [operationIsCurrent, syncDocumentSelection]);

  const confirmDocumentSelection = useCallback(async (
    operationId: number,
    lifecycleGeneration: number
  ) => {
    const pending = documentSelectionRef.current;
    const operation = activeOperationRef.current;
    if (
      !pending
      || pending.loading
      || pending.operationId !== operationId
      || pending.lifecycleGeneration !== lifecycleGeneration
      || !pending.selectedDocumentId
      || !operation
      || operation.id !== pending.operationId
      || !operationIsCurrent(operation)
      || normalizePath(pending.inspectedPath) !== normalizePath(transcriptFileRef.current)
      || !document.snapshotIsCurrent(pending.documentSnapshot)
    ) {
      return false;
    }
    const loadingSelection = { ...pending, loading: true };
    syncDocumentSelection(loadingSelection);
    return await loadInspectedDocument(
      operation,
      loadingSelection.inspectedPath,
      loadingSelection.selectedDocumentId,
      loadingSelection.format,
      loadingSelection.documentSnapshot
    );
  }, [document, loadInspectedDocument, operationIsCurrent, syncDocumentSelection]);

  const cancelDocumentSelection = useCallback((operationId: number, lifecycleGeneration: number) => {
    const pending = documentSelectionRef.current;
    const operation = activeOperationRef.current;
    if (
      !pending
      || pending.operationId !== operationId
      || pending.lifecycleGeneration !== lifecycleGeneration
    ) {
      return false;
    }
    syncDocumentSelection(null);
    if (operation?.id === pending.operationId) {
      finishOperation(operation);
    }
    return true;
  }, [finishOperation, syncDocumentSelection]);

  const pickMedia = useCallback(async () => {
    const operation = beginOperation("pick-media", "Choosing media");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    try {
      const selected = await pickMediaFile(
        snapshot.transcript?.media_file || proposedMediaFileRef.current || transcriptFileRef.current || undefined
      );
      if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
        finishOperation(operation);
        return false;
      }
      if (!selected) {
        finishOperation(operation);
        return false;
      }
      syncProposedMedia(selected);
      if (snapshot.transcript) {
        document.applyMediaFromLifecycle(snapshot, selected);
        setStatusMessage("Media linked to the edited transcript.");
      } else {
        setStatusMessage("Media selected. Load a transcript or editing copy to link playback.");
      }
      finishOperation(operation);
      return true;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        if (document.snapshotIsCurrent(snapshot)) {
          setErrorMessage(safeError(error, "Media picker failed."));
        }
        finishOperation(operation);
      }
      return false;
    }
  }, [beginOperation, document, finishOperation, operationIsCurrent, syncProposedMedia]);

  const clearMedia = useCallback(() => {
    const operation = beginOperation("pick-media", "Clearing media");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    syncProposedMedia("");
    if (snapshot.transcript) {
      document.applyMediaFromLifecycle(snapshot, "");
    }
    finishOperation(operation);
    return true;
  }, [beginOperation, document, finishOperation, syncProposedMedia]);

  const saveWorkingCopy = useCallback(async (saveAs: boolean) => {
    const operation = beginOperation("save", saveAs ? "Choosing save location" : "Saving editing copy");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    if (!snapshot.transcript) {
      finishOperation(operation);
      return false;
    }
    try {
      let selectedPath = savePathRef.current;
      if (saveAs || !selectedPath) {
        const defaultName = `${exportNameRef.current || fileStem(transcriptFileRef.current) || "edited_transcript"}.json`;
        selectedPath = await pickSaveFile(defaultName, savePathRef.current || transcriptFileRef.current || undefined) ?? "";
        if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
          finishOperation(operation);
          return false;
        }
        if (!selectedPath) {
          finishOperation(operation);
          return false;
        }
      }
      const result = await saveEditorTranscript(selectedPath, snapshot.transcript);
      if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
        finishOperation(operation);
        return false;
      }
      if (!document.applySuccessfulSave(snapshot, result.validation_issues)) {
        finishOperation(operation);
        return false;
      }
      syncSavePath(result.output_file);
      setStatusMessage(`Saved editing copy ${fileName(result.output_file)}.`);
      finishOperation(operation);
      return true;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        if (document.snapshotIsCurrent(snapshot)) {
          setErrorMessage(safeError(error, "Edited transcript could not be saved."));
        }
        finishOperation(operation);
      }
      return false;
    }
  }, [beginOperation, document, finishOperation, operationIsCurrent, syncSavePath]);

  const setExportFormats = useCallback((formats: string[]) => {
    if (isLocked()) {
      return false;
    }
    const next = [...formats];
    exportFormatsRef.current = next;
    setExportFormatsState(next);
    return true;
  }, [isLocked]);

  const exportTranscript = useCallback(async () => {
    const operation = beginOperation("export", "Exporting transcript");
    if (!operation) {
      return false;
    }
    const snapshot = document.getSnapshot();
    const preferences = {
      folder: exportFolderRef.current,
      name: exportNameRef.current,
      formats: [...exportFormatsRef.current]
    };
    if (!snapshot.transcript || preferences.formats.length === 0) {
      finishOperation(operation);
      return false;
    }
    try {
      const defaultName = preferences.name || `${fileStem(transcriptFileRef.current)}_edited` || "edited_transcript";
      const defaultFormat = preferences.formats[0] || "xlsx";
      const selected = await pickEditorExportFile(
        `${defaultName}.${defaultFormat}`,
        preferences.folder || folderName(transcriptFileRef.current) || undefined,
        preferences.formats
      );
      if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
        finishOperation(operation);
        return false;
      }
      if (!selected) {
        finishOperation(operation);
        return false;
      }
      const selectedFolder = folderName(selected);
      const selectedName = fileStem(selected);
      if (!selectedFolder) {
        throw new Error("Choose a valid folder for the transcript export.");
      }
      syncExportFolder(selectedFolder);
      syncExportName(selectedName);
      const result = await exportEditorTranscript({
        transcript: snapshot.transcript,
        output_folder: selectedFolder,
        output_name: selectedName,
        export_formats: preferences.formats,
        transcript_layout: "segment"
      });
      if (!operationIsCurrent(operation) || !document.snapshotIsCurrent(snapshot)) {
        finishOperation(operation);
        return false;
      }
      document.applyExportValidation(snapshot, result.validation_issues);
      syncExportFiles(result.output_files);
      const created = result.output_files.filter((file) => file.exists);
      setStatusMessage(`Exported ${created.length} transcript file(s).`);
      finishOperation(operation);
      return true;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        if (document.snapshotIsCurrent(snapshot)) {
          setErrorMessage(safeError(error, "Edited transcript export failed."));
        }
        finishOperation(operation);
      }
      return false;
    }
  }, [beginOperation, document, finishOperation, operationIsCurrent, syncExportFiles, syncExportFolder, syncExportName]);

  const openLocalPath = useCallback(async (path: string, expectDirectory = false) => {
    if (!path.trim()) {
      return false;
    }
    const operation = beginOperation("open-path", expectDirectory ? "Opening folder" : "Opening file");
    if (!operation) {
      return false;
    }
    const capturedGeneration = lifecycleGenerationRef.current;
    try {
      await openPath({ path, expect_directory: expectDirectory, create_if_missing: false });
      if (!operationIsCurrent(operation) || capturedGeneration !== lifecycleGenerationRef.current) {
        finishOperation(operation);
        return false;
      }
      finishOperation(operation);
      return true;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        if (capturedGeneration === lifecycleGenerationRef.current) {
          setErrorMessage(safeError(error, "The selected path could not be opened."));
        }
        finishOperation(operation);
      }
      return false;
    }
  }, [beginOperation, finishOperation, operationIsCurrent]);

  const closeEditor = useCallback(() => {
    if (isLocked()) {
      return false;
    }
    setEditorMode("setup");
    return true;
  }, [isLocked]);

  const activeMediaFile = document.getSnapshot().transcript?.media_file || proposedMediaFile;
  const activityLabel = activeOperation?.label ?? "";

  return useMemo(() => ({
    editorMode,
    transcriptFile,
    proposedMediaFile,
    activeMediaFile,
    savePath,
    exportFolder,
    exportName,
    exportFormats,
    lastExportFiles,
    statusMessage,
    errorMessage,
    busy: Boolean(activeOperation),
    activityLabel,
    sourceReplacement,
    documentSelection,
    isLocked,
    publishDocumentStatus,
    pickTranscript,
    clearTranscript,
    confirmSourceReplacement,
    cancelSourceReplacement,
    inspectAndLoadTranscript,
    chooseDocument,
    confirmDocumentSelection,
    cancelDocumentSelection,
    pickMedia,
    clearMedia,
    saveWorkingCopy,
    setExportFormats,
    exportTranscript,
    openTranscript: () => openLocalPath(transcriptFileRef.current),
    openMedia: () => openLocalPath(document.getSnapshot().transcript?.media_file || proposedMediaFileRef.current),
    openOutputFolder: () => openLocalPath(exportFolderRef.current, true),
    closeEditor
  }), [activeMediaFile, activeOperation, activityLabel, cancelDocumentSelection, cancelSourceReplacement, chooseDocument, clearMedia, clearTranscript, closeEditor, confirmDocumentSelection, confirmSourceReplacement, document, documentSelection, editorMode, errorMessage, exportFolder, exportFormats, exportName, exportTranscript, inspectAndLoadTranscript, isLocked, lastExportFiles, openLocalPath, pickMedia, pickTranscript, proposedMediaFile, publishDocumentStatus, savePath, saveWorkingCopy, setExportFormats, sourceReplacement, statusMessage, transcriptFile]);
}
