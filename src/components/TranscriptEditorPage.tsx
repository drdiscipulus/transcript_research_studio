import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { useEditorDocumentWorkspace } from "../hooks/useEditorDocumentWorkspace";
import { useEditorFileLifecycle } from "../hooks/useEditorFileLifecycle";
import { localMediaUrl, type EditorTranscript } from "../lib/api";
import {
  buildSpeakerNameMap,
  segmentHasPlayableTimestamps,
  sortSpeakersForDisplay
} from "../lib/editorState";
import { EditorMediaPlayer } from "./EditorMediaPlayer";
import { EditorConfirmationDialog } from "./editor/EditorConfirmationDialog";
import { EditorDocumentSelectionDialog } from "./editor/EditorDocumentSelectionDialog";
import { EditorExportBar } from "./editor/EditorExportBar";
import { EditorSetupPanel } from "./editor/EditorSetupPanel";
import { EditorWorkspaceHeader } from "./editor/EditorWorkspaceHeader";
import { SegmentCard } from "./editor/SegmentCard";
import { SegmentToolbar } from "./editor/SegmentToolbar";
import { SpeakerPanel } from "./editor/SpeakerPanel";
import { ValidationList } from "./editor/ValidationList";
import { SEGMENTS_PER_PAGE_OPTIONS } from "./editor/editorConstants";
import { useWorkbenchPageLifecycle } from "./workbench/WorkbenchLifecycle";

type PendingDocumentConfirmation = {
  id: number;
  kind: "remove-speaker" | "reset";
  speakerId?: string;
  transcriptIdentity: EditorTranscript | null;
  documentGeneration: number;
  editRevision: number;
};

type LifecycleCoordinator = {
  isLocked: () => boolean;
  publishDocumentStatus: (message: string) => void;
  saveWorkingCopy: (saveAs: boolean) => Promise<boolean>;
};

export function TranscriptEditorPage() {
  const lifecycleCoordinatorRef = useRef<LifecycleCoordinator | null>(null);
  const confirmationSequenceRef = useRef(0);
  const confirmationRef = useRef<PendingDocumentConfirmation | null>(null);
  const [confirmation, setConfirmation] = useState<PendingDocumentConfirmation | null>(null);
  const keyboardShortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

  const documentWorkspace = useEditorDocumentWorkspace({
    isOperationLocked: () => lifecycleCoordinatorRef.current?.isLocked() ?? false,
    publishStatus: (message) => lifecycleCoordinatorRef.current?.publishDocumentStatus(message)
  });

  const documentBridge = useMemo(() => ({
    getSnapshot: documentWorkspace.getSnapshot,
    snapshotIsCurrent: documentWorkspace.snapshotIsCurrent,
    applyLoadedDocument: documentWorkspace.applyLoadedDocument,
    applySuccessfulSave: documentWorkspace.applySuccessfulSave,
    applyExportValidation: documentWorkspace.applyExportValidation,
    applyMediaFromLifecycle: documentWorkspace.applyMediaFromLifecycle,
    clearDocument: documentWorkspace.clearDocument
  }), [
    documentWorkspace.applyExportValidation,
    documentWorkspace.applyLoadedDocument,
    documentWorkspace.applyMediaFromLifecycle,
    documentWorkspace.applySuccessfulSave,
    documentWorkspace.clearDocument,
    documentWorkspace.getSnapshot,
    documentWorkspace.snapshotIsCurrent
  ]);

  const fileLifecycle = useEditorFileLifecycle({
    document: documentBridge,
    isWorkspaceOperationLocked: () => confirmationRef.current !== null
  });
  lifecycleCoordinatorRef.current = {
    isLocked: fileLifecycle.isLocked,
    publishDocumentStatus: fileLifecycle.publishDocumentStatus,
    saveWorkingCopy: fileLifecycle.saveWorkingCopy
  };

  const editorIsActive = useWorkbenchPageLifecycle("editor", {
    dirty: documentWorkspace.dirty,
    activeJob: fileLifecycle.busy,
    activityLabel: fileLifecycle.busy
      ? fileLifecycle.activityLabel
      : documentWorkspace.dirty
        ? "Editor has unsaved transcript changes"
        : ""
  });

  const transcript = documentWorkspace.transcript;
  const validationIssues = transcript?.validation_issues ?? [];
  const errors = validationIssues.filter((issue) => issue.level === "error");
  const warnings = validationIssues.filter((issue) => issue.level !== "error");
  const activeMediaFile = fileLifecycle.activeMediaFile;
  const mediaUrl = activeMediaFile ? localMediaUrl(activeMediaFile) : "";
  const displaySpeakers = useMemo(
    () => sortSpeakersForDisplay(transcript?.speakers ?? []),
    [transcript?.speakers]
  );
  const speakerNameMap = useMemo(
    () => buildSpeakerNameMap(transcript?.speakers ?? []),
    [transcript?.speakers]
  );
  const statusLabel = fileLifecycle.errorMessage || (
    transcript
      ? fileLifecycle.statusMessage
      : "No transcript loaded: Use a JSON, CSV, XLSX, or app-generated DOCX export, or reopen a saved editing copy."
  );
  const segmentRangeLabel = documentWorkspace.totalSegments > 0
    ? `${documentWorkspace.pageStart + 1}-${documentWorkspace.pageEnd} of ${documentWorkspace.totalSegments}`
    : "0 of 0";
  const workspaceLocked = fileLifecycle.isLocked();

  const openDocumentConfirmation = (next: Omit<
    PendingDocumentConfirmation,
    "id" | "transcriptIdentity" | "documentGeneration" | "editRevision"
  >) => {
    if (fileLifecycle.isLocked()) {
      return false;
    }
    const snapshot = documentWorkspace.getSnapshot();
    confirmationSequenceRef.current += 1;
    const pending = {
      ...next,
      id: confirmationSequenceRef.current,
      transcriptIdentity: snapshot.transcript,
      documentGeneration: snapshot.documentGeneration,
      editRevision: snapshot.editRevision
    };
    confirmationRef.current = pending;
    setConfirmation(pending);
    return true;
  };

  const closeDocumentConfirmation = (confirmationId: number) => {
    if (confirmationRef.current?.id !== confirmationId) {
      return false;
    }
    confirmationRef.current = null;
    setConfirmation(null);
    return true;
  };

  const confirmDocumentAction = (confirmationId: number) => {
    const pending = confirmationRef.current;
    if (!pending || pending.id !== confirmationId) {
      return false;
    }
    const snapshot = documentWorkspace.getSnapshot();
    if (
      snapshot.transcript !== pending.transcriptIdentity
      || snapshot.documentGeneration !== pending.documentGeneration
      || snapshot.editRevision !== pending.editRevision
    ) {
      closeDocumentConfirmation(confirmationId);
      return false;
    }
    closeDocumentConfirmation(confirmationId);
    if (pending.kind === "remove-speaker" && pending.speakerId) {
      return documentWorkspace.removeSpeaker(pending.speakerId);
    }
    return pending.kind === "reset"
      ? documentWorkspace.resetToBaseline(Boolean(fileLifecycle.savePath))
      : false;
  };

  const requestSpeakerRemoval = (speakerId: string) => {
    if (fileLifecycle.isLocked()) {
      return false;
    }
    if (documentWorkspace.speakerIsUsed(speakerId)) {
      return openDocumentConfirmation({ kind: "remove-speaker", speakerId });
    }
    return documentWorkspace.removeSpeaker(speakerId);
  };

  const requestReset = () => {
    if (!documentWorkspace.dirty || fileLifecycle.isLocked()) {
      return;
    }
    openDocumentConfirmation({ kind: "reset" });
  };

  keyboardShortcutHandlerRef.current = (event: KeyboardEvent) => {
    const current = documentWorkspace.getSnapshot().transcript;
    if (!current || fileLifecycle.editorMode !== "editing") {
      return;
    }
    const commandKey = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const isUndo = commandKey && !event.shiftKey && key === "z";
    const isRedo = commandKey && (key === "y" || (event.shiftKey && key === "z"));
    const isSave = commandKey && !event.shiftKey && key === "s";
    if (fileLifecycle.isLocked()) {
      if (isSave || isUndo || isRedo || event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === " ") {
        event.preventDefault();
      }
      return;
    }
    if (isSave) {
      event.preventDefault();
      if (documentWorkspace.dirty || !fileLifecycle.savePath) {
        void lifecycleCoordinatorRef.current?.saveWorkingCopy(false);
      }
      return;
    }
    if (isUndo) {
      event.preventDefault();
      documentWorkspace.undo();
      return;
    }
    if (isRedo) {
      event.preventDefault();
      documentWorkspace.redo();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      documentWorkspace.activateSegment(Math.min(
        documentWorkspace.activeSegmentIndex + 1,
        current.segments.length - 1
      ));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      documentWorkspace.activateSegment(Math.max(documentWorkspace.activeSegmentIndex - 1, 0));
    } else if (event.key === " ") {
      event.preventDefault();
      documentWorkspace.toggleSegmentPlayback(documentWorkspace.activeSegmentIndex);
    }
  };

  useEffect(() => {
    if (!editorIsActive) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      keyboardShortcutHandlerRef.current(event);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorIsActive]);

  useEffect(() => () => {
    confirmationRef.current = null;
  }, []);

  const sourceConfirmationDescription = fileLifecycle.sourceReplacement
    ? "You have unsaved edits. Load another transcript and replace the current editor state?"
    : "";
  const resetTarget = fileLifecycle.savePath
    ? "the last saved editing copy"
    : "the originally loaded transcript";

  const dialogs = (
    <>
      <EditorConfirmationDialog
        open={Boolean(fileLifecycle.sourceReplacement)}
        title={fileLifecycle.sourceReplacement?.action === "clear" ? "Clear Transcript?" : "Replace Transcript?"}
        description={sourceConfirmationDescription}
        confirmLabel={fileLifecycle.sourceReplacement?.action === "clear" ? "Clear Transcript" : "Replace Transcript"}
        onConfirm={() => {
          const pending = fileLifecycle.sourceReplacement;
          if (pending) {
            fileLifecycle.confirmSourceReplacement(pending.operationId, pending.lifecycleGeneration);
          }
        }}
        onCancel={() => {
          const pending = fileLifecycle.sourceReplacement;
          if (pending) {
            fileLifecycle.cancelSourceReplacement(pending.operationId, pending.lifecycleGeneration);
          }
        }}
      />
      <EditorConfirmationDialog
        open={Boolean(confirmation)}
        title={confirmation?.kind === "remove-speaker" ? "Delete Speaker?" : "Reset Changes?"}
        description={confirmation?.kind === "remove-speaker"
          ? "This speaker is used by segments. Remove it and clear those segment labels?"
          : `Reset all editor changes and restore ${resetTarget}?`}
        confirmLabel={confirmation?.kind === "remove-speaker" ? "Delete Speaker" : "Reset Changes"}
        onConfirm={() => {
          if (confirmation) {
            confirmDocumentAction(confirmation.id);
          }
        }}
        onCancel={() => {
          if (confirmation) {
            closeDocumentConfirmation(confirmation.id);
          }
        }}
      />
      {fileLifecycle.documentSelection ? (
        <EditorDocumentSelectionDialog
          inspectedPath={fileLifecycle.documentSelection.inspectedPath}
          documents={fileLifecycle.documentSelection.documents}
          selectedDocumentId={fileLifecycle.documentSelection.selectedDocumentId}
          loading={fileLifecycle.documentSelection.loading}
          onSelect={(documentId) => fileLifecycle.chooseDocument(
            fileLifecycle.documentSelection?.operationId ?? -1,
            fileLifecycle.documentSelection?.lifecycleGeneration ?? -1,
            documentId
          )}
          onLoad={() => {
            const pending = fileLifecycle.documentSelection;
            if (pending) {
              void fileLifecycle.confirmDocumentSelection(pending.operationId, pending.lifecycleGeneration);
            }
          }}
          onCancel={() => {
            const pending = fileLifecycle.documentSelection;
            if (pending) {
              fileLifecycle.cancelDocumentSelection(pending.operationId, pending.lifecycleGeneration);
            }
          }}
        />
      ) : null}
    </>
  );

  if (fileLifecycle.editorMode === "editing" && transcript) {
    return (
      <div className="page-stack transcript-editor-page editor-workspace-page">
        <EditorWorkspaceHeader
          dirty={documentWorkspace.dirty}
          hasSavePath={Boolean(fileLifecycle.savePath)}
          busy={workspaceLocked}
          statusMessage={statusLabel}
          hasError={Boolean(fileLifecycle.errorMessage)}
          segmentCount={documentWorkspace.totalSegments}
          onSave={() => void fileLifecycle.saveWorkingCopy(false)}
          onSaveAs={() => void fileLifecycle.saveWorkingCopy(true)}
          onResetChanges={requestReset}
          onCloseEditor={fileLifecycle.closeEditor}
        />

        <EditorExportBar
          exportFormats={fileLifecycle.exportFormats}
          outputFiles={fileLifecycle.lastExportFiles}
          busy={workspaceLocked}
          onExportFormatsChange={fileLifecycle.setExportFormats}
          onExport={() => void fileLifecycle.exportTranscript()}
          onOpenOutputFolder={() => void fileLifecycle.openOutputFolder()}
        />

        <div className="editor-sticky-media">
          <EditorMediaPlayer
            mediaPath={activeMediaFile}
            mediaUrl={mediaUrl}
            playRequest={documentWorkspace.playRequest}
            onPlaybackStateChange={documentWorkspace.handlePlaybackStateChange}
            compact
          />
        </div>

        <SpeakerPanel
          speakers={displaySpeakers}
          mutationLocked={workspaceLocked}
          onUpdateSpeaker={documentWorkspace.updateSpeaker}
          onRemoveSpeaker={requestSpeakerRemoval}
          onAddSpeaker={documentWorkspace.addSpeaker}
        />

        {(errors.length > 0 || warnings.length > 0) ? (
          <section className="section-card validation-panel">
            <h3 className="home-section-title">Validation</h3>
            <ValidationList title="Errors" issues={errors} />
            <ValidationList title="Warnings" issues={warnings.slice(0, 8)} />
          </section>
        ) : null}

        <section className="section-card segment-editor-panel">
          <SegmentToolbar
            segmentRangeLabel={segmentRangeLabel}
            totalSegments={documentWorkspace.totalSegments}
            totalPages={documentWorkspace.totalPages}
            currentPage={documentWorkspace.currentPage}
            segmentsPerPage={documentWorkspace.segmentsPerPage}
            pageSizeOptions={SEGMENTS_PER_PAGE_OPTIONS}
            canUndo={documentWorkspace.historyPast.length > 0}
            canRedo={documentWorkspace.historyFuture.length > 0}
            mutationLocked={workspaceLocked}
            onUndo={documentWorkspace.undo}
            onRedo={documentWorkspace.redo}
            onMergeAdjacentSameSpeakerSegments={documentWorkspace.mergeAdjacent}
            onSegmentsPerPageChange={documentWorkspace.setSegmentsPerPage}
            onPageChange={documentWorkspace.activatePage}
            onPreviousPage={() => documentWorkspace.setPage(documentWorkspace.currentPage - 1)}
            onNextPage={() => documentWorkspace.setPage(documentWorkspace.currentPage + 1)}
          />
          <div className="segment-card-list">
            {documentWorkspace.visibleSegments.map((segment, visibleIndex) => {
              const index = documentWorkspace.pageStart + visibleIndex;
              const canPlay = Boolean(transcript.media_file) && segmentHasPlayableTimestamps(segment);
              const isPlaying = documentWorkspace.playbackState?.segmentId === segment.id
                && documentWorkspace.playbackState.status === "playing";
              return (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  index={index}
                  active={index === documentWorkspace.activeSegmentIndex}
                  speakers={displaySpeakers}
                  speakerNameMap={speakerNameMap}
                  canPlay={canPlay}
                  isPlaying={isPlaying}
                  canMergeNext={index < transcript.segments.length - 1}
                  canDelete={transcript.segments.length > 1}
                  mutationLocked={workspaceLocked}
                  onActivate={documentWorkspace.activateSegment}
                  onPlayPause={documentWorkspace.toggleSegmentPlayback}
                  onStop={documentWorkspace.stopSegmentPlayback}
                  onUpdateSegment={documentWorkspace.updateSegment}
                  onRememberCursor={documentWorkspace.rememberCursorPosition}
                  onSplit={documentWorkspace.splitSegment}
                  onMergeNext={documentWorkspace.mergeWithNext}
                  onDelete={documentWorkspace.deleteSegment}
                />
              );
            })}
          </div>
        </section>
        {dialogs}
      </div>
    );
  }

  return (
    <>
      <EditorSetupPanel
        transcriptFile={fileLifecycle.transcriptFile}
        activeMediaFile={activeMediaFile}
        transcript={transcript}
        dirty={documentWorkspace.dirty}
        savePath={fileLifecycle.savePath}
        busy={workspaceLocked}
        errorMessage={fileLifecycle.errorMessage}
        statusLabel={statusLabel}
        canInspectOrEdit={Boolean(fileLifecycle.transcriptFile.trim()) && !workspaceLocked}
        onPickTranscript={() => void fileLifecycle.pickTranscript()}
        onResetTranscript={fileLifecycle.clearTranscript}
        onOpenTranscript={() => void fileLifecycle.openTranscript()}
        onPickMedia={() => void fileLifecycle.pickMedia()}
        onResetMedia={fileLifecycle.clearMedia}
        onOpenMedia={() => void fileLifecycle.openMedia()}
        onOpenEditor={() => void fileLifecycle.inspectAndLoadTranscript()}
      />
      {dialogs}
    </>
  );
}
