import type { EditorTranscript } from "../../lib/api";
import { fileName } from "../../lib/editorState";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import { WorkflowPathField } from "../WorkflowPathField";
import { EDITOR_FIELD_HELP_TEXT } from "./editorConstants";

type EditorSetupPanelProps = {
  transcriptFile: string;
  activeMediaFile: string;
  transcript: EditorTranscript | null;
  dirty: boolean;
  savePath: string;
  busy: boolean;
  errorMessage: string | null;
  statusLabel: string;
  canInspectOrEdit: boolean;
  onPickTranscript: () => void;
  onResetTranscript: () => void;
  onOpenTranscript: () => void;
  onPickMedia: () => void;
  onResetMedia: () => void;
  onOpenMedia: () => void;
  onOpenEditor: () => void;
};

export function EditorSetupPanel({
  transcriptFile,
  activeMediaFile,
  transcript,
  dirty,
  savePath,
  busy,
  errorMessage,
  statusLabel,
  canInspectOrEdit,
  onPickTranscript,
  onResetTranscript,
  onOpenTranscript,
  onPickMedia,
  onResetMedia,
  onOpenMedia,
  onOpenEditor
}: EditorSetupPanelProps) {
  return (
    <div className="page-stack transcript-editor-page">
      <section className="page-header compact-page-header transcription-page-header">
        <div>
          <h2 className="home-main-title">Transcript Editor</h2>
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Inputs</h3>
          </div>
        </div>
        <div className="editor-input-grid">
          <WorkflowPathField
            label="Transcript or Editing Copy"
            helpText={EDITOR_FIELD_HELP_TEXT.transcript}
            value={transcriptFile}
            placeholder="Choose a transcript or editing copy"
            onBrowse={onPickTranscript}
            onOpen={onOpenTranscript}
            onReset={onResetTranscript}
            resetLabel="Clear"
            inlineBrowse
            disabled={busy}
          />

          <WorkflowPathField
            label="Media File (Optional)"
            helpText={EDITOR_FIELD_HELP_TEXT.media}
            value={activeMediaFile}
            placeholder="Choose a media file"
            onBrowse={onPickMedia}
            onOpen={onOpenMedia}
            onReset={onResetMedia}
            resetLabel="Clear"
            inlineBrowse
            disabled={busy}
          />
        </div>

        <div className="editor-load-row">
          <button
            type="button"
            className="primary-button"
            onClick={onOpenEditor}
            disabled={!canInspectOrEdit}
          >
            Load Transcript
          </button>
          <div className={`editor-setup-status${errorMessage ? " error" : ""}`} role={errorMessage ? "alert" : "status"}>
            <span>Status</span>
            <strong>{statusLabel}</strong>
          </div>
        </div>
      </section>

      {transcript ? (
        <section className="section-card">
          <div className="section-heading">
            <div>
              <h3 className="home-section-title">
                <FieldLabelWithHelp
                  label="Current Transcript"
                  helpText={EDITOR_FIELD_HELP_TEXT.edit}
                  labelClassName="home-section-title"
                />
              </h3>
            </div>
          </div>

          <div className="editor-loaded-summary">
            <article className="summary-panel">
              <span className="summary-label">Transcript</span>
              <strong>{fileName(transcript.source_transcript_file || transcriptFile)}</strong>
            </article>
            <article className="summary-panel">
              <span className="summary-label">Segments</span>
              <strong>{transcript.segments.length}</strong>
            </article>
            <article className="summary-panel">
              <span className="summary-label">Speakers</span>
              <strong>{transcript.speakers.length}</strong>
            </article>
            <article className="summary-panel">
              <span className="summary-label">State</span>
              <strong>{dirty ? "Unsaved Edits" : savePath ? "Editing Copy Saved" : "In Memory"}</strong>
            </article>
          </div>

          {errorMessage ? <div className="inline-error">{errorMessage}</div> : null}
        </section>
      ) : null}

    </div>
  );
}
