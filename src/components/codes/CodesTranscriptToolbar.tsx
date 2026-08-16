import { useRef } from "react";
import type { CodesProject, CodesTranscript, TranscriptImportResult } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";

type ImportResultSummary = Pick<TranscriptImportResult, "imported" | "skipped" | "failed">;

type CodesTranscriptToolbarProps = {
  project: CodesProject;
  activeTranscript: CodesTranscript | null;
  activeTranscriptId: string;
  importResult: ImportResultSummary | null;
  importPreviewPending: boolean;
  busy: boolean;
  canEditProject: boolean;
  onSelectTranscript: (transcriptId: string) => void;
  onAddTranscriptFolder: () => void;
  onAddTranscriptFile: () => void;
  onRemoveTranscript: (transcript: CodesTranscript) => void;
  onDismissImportResult: () => void;
};

export function CodesTranscriptToolbar({
  project,
  activeTranscript,
  activeTranscriptId,
  importResult,
  importPreviewPending,
  busy,
  canEditProject,
  onSelectTranscript,
  onAddTranscriptFolder,
  onAddTranscriptFile,
  onRemoveTranscript,
  onDismissImportResult
}: CodesTranscriptToolbarProps) {
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  const evidenceCount = activeTranscript
    ? project.evidence_items.filter((evidence) => evidence.transcript_id === activeTranscript.transcript_id).length
    : 0;
  const hasImportProblems = Boolean(importResult?.skipped.length || importResult?.failed.length);
  const addTranscriptsDisabled = !canEditProject || busy || importPreviewPending;

  function invokeMenuAction(ref: typeof addMenuRef, action: () => void) {
    if (ref.current) ref.current.open = false;
    action();
  }

  return (
    <section className="section-card codes-transcript-toolbar" aria-label="Transcript Navigator">
      <div className="codes-transcript-toolbar-main">
        <div className="field-group codes-transcript-select-field">
          <FieldLabelWithHelp label="Transcript" helpText="Choose which imported transcript to read and code." htmlFor="codes-active-transcript" />
          <select
            id="codes-active-transcript"
            className="text-input"
            value={activeTranscriptId}
            disabled={busy || project.transcripts.length === 0}
            onChange={(event) => onSelectTranscript(event.target.value)}
          >
            {project.transcripts.map((transcript) => (
              <option key={transcript.transcript_id} value={transcript.transcript_id}>{transcript.label}</option>
            ))}
          </select>
        </div>

        <div className="codes-transcript-toolbar-meta" aria-live="polite">
          <span><strong>{activeTranscript?.segments.length ?? 0}</strong> Segments</span>
          <span><strong>{evidenceCount}</strong> Evidence Items</span>
        </div>

        <div className="codes-transcript-toolbar-actions">
          <details ref={addMenuRef} className="codes-toolbar-menu">
            <summary className="secondary-button" aria-label="Add Transcripts">Add Transcripts</summary>
            <div className="codes-toolbar-menu-content">
              <button type="button" onClick={() => invokeMenuAction(addMenuRef, onAddTranscriptFolder)} disabled={addTranscriptsDisabled}>Add Transcript Folder</button>
              <button type="button" onClick={() => invokeMenuAction(addMenuRef, onAddTranscriptFile)} disabled={addTranscriptsDisabled}>Add Transcript File</button>
            </div>
          </details>
          <button
            type="button"
            className="secondary-button danger-button"
            title="Remove this transcript from the coding project. The original source file will not be deleted."
            onClick={() => activeTranscript && onRemoveTranscript(activeTranscript)}
            disabled={!activeTranscript || !canEditProject || busy}
          >
            Remove Transcript
          </button>
        </div>
      </div>

      {importResult ? (
        <div className={`codes-import-result-banner${hasImportProblems ? " warning" : ""}`} role={importResult.failed.length ? "alert" : "status"}>
          {hasImportProblems ? (
            <details>
              <summary>{importResult.imported.length} imported · {importResult.skipped.length} skipped · {importResult.failed.length} failed</summary>
              <div className="codes-import-result-details">
                {importResult.skipped.map((item) => <small key={`skip-${item.candidate_id}`}>{item.source_path}: {item.reason}</small>)}
                {importResult.failed.map((item) => <small key={`fail-${item.candidate_id}`} className="error-text">{item.source_path}: {item.reason}</small>)}
              </div>
            </details>
          ) : (
            <span>{importResult.imported.length} transcript{importResult.imported.length === 1 ? "" : "s"} imported.</span>
          )}
          <button type="button" className="text-button" onClick={onDismissImportResult}>Dismiss</button>
        </div>
      ) : null}
    </section>
  );
}
