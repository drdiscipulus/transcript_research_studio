import type {
  TranscriptImportCandidate,
  TranscriptImportPreview,
  TranscriptImportResult
} from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";

type CodesImportPanelProps = {
  preview: TranscriptImportPreview | null;
  selectedCandidateIds: string[];
  result: Pick<TranscriptImportResult, "imported" | "skipped" | "failed"> | null;
  busy: boolean;
  canEditProject: boolean;
  compact?: boolean;
  onChooseFolder: () => void;
  onChooseFile: () => void;
  onToggleCandidate: (candidate: TranscriptImportCandidate) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

function candidateStatusLabel(candidate: TranscriptImportCandidate) {
  return {
    ready: "Ready",
    already_imported: "Already Imported",
    alternate_format: "Alternate Format",
    problem: "Problem"
  }[candidate.status];
}

export function CodesImportPanel({
  preview,
  selectedCandidateIds,
  result,
  busy,
  canEditProject,
  compact = false,
  onChooseFolder,
  onChooseFile,
  onToggleCandidate,
  onConfirm,
  onCancel
}: CodesImportPanelProps) {
  const sourceSelectionDisabled = !canEditProject || busy || Boolean(preview);
  const candidateLabel = preview?.candidates.length === 1 ? "Candidate" : "Candidates";

  return (
    <section className={compact ? "section-card codes-import-panel compact" : "section-card codes-import-panel"}>
      <div className="codes-import-heading">
        <h3 className="home-section-title">
          <FieldLabelWithHelp
            label="Import Transcripts"
            helpText="Import JSON, XLSX, CSV, or DOCX transcript exports. Folder scanning is nonrecursive; JSON is preferred when equivalent formats are found."
            labelClassName="home-section-title"
          />
        </h3>
        <div className="action-row codes-import-actions">
          <button type="button" className="secondary-button codes-import-action-button" onClick={onChooseFolder} disabled={sourceSelectionDisabled}>
            Add Transcript Folder
          </button>
          <button type="button" className="secondary-button codes-import-action-button" onClick={onChooseFile} disabled={sourceSelectionDisabled}>
            Add Transcript File
          </button>
        </div>
      </div>

      {preview ? (
        <div className="codes-import-preview" aria-live="polite">
          <details className="codes-import-preview-details">
            <summary className="codes-import-preview-summary">
              <span className="transcription-advanced-chevron" aria-hidden="true">›</span>
              <strong>Import Preview ({preview.candidates.length} {candidateLabel})</strong>
              <span className="codes-import-counts">
                <span>{preview.counts.ready} Ready</span>
                <span>{preview.counts.alternate_format} Alternate</span>
                <span>{preview.counts.already_imported} Already Imported</span>
                <span>{preview.counts.problem} Problems</span>
              </span>
            </summary>
            <div className="codes-import-candidate-list" aria-label="Transcript import preview">
              {preview.candidates.map((candidate) => {
                const selectable = candidate.status === "ready" || candidate.status === "alternate_format";
                return (
                  <label key={candidate.candidate_id} className={`codes-import-candidate ${candidate.status}`}>
                    <input
                      type="checkbox"
                      checked={selectedCandidateIds.includes(candidate.candidate_id)}
                      disabled={!selectable || busy}
                      onChange={() => onToggleCandidate(candidate)}
                    />
                    <span className="codes-import-candidate-main">
                      <strong>{candidate.title}</strong>
                      <small>{candidate.source_path}</small>
                    </span>
                    <span>{candidate.format.toUpperCase()}</span>
                    <span>{candidate.segment_count} segments</span>
                    <span className={`codes-import-status ${candidate.status}`}>{candidateStatusLabel(candidate)}</span>
                    <small className="codes-import-reason">{candidate.reason}</small>
                  </label>
                );
              })}
            </div>
          </details>
          <div className="action-row field-action-row">
            <button type="button" className="primary-button" onClick={onConfirm} disabled={busy || selectedCandidateIds.length === 0}>
              Import Selected ({selectedCandidateIds.length})
            </button>
            <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="codes-import-results" role={result.failed.length ? "alert" : "status"}>
          <strong>Import Results</strong>
          <span>{result.imported.length} imported · {result.skipped.length} skipped · {result.failed.length} failed</span>
          {result.skipped.map((item) => (
            <small key={`skip-${item.candidate_id}`}>{item.source_path}: {item.reason}</small>
          ))}
          {result.failed.map((item) => (
            <small key={`failed-${item.candidate_id}`} className="error-text">{item.source_path}: {item.reason}</small>
          ))}
        </div>
      ) : null}
    </section>
  );
}
