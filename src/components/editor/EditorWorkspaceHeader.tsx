import { EDITOR_FIELD_HELP_TEXT } from "./editorConstants";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";

type EditorWorkspaceHeaderProps = {
  dirty: boolean;
  hasSavePath: boolean;
  busy: boolean;
  statusMessage: string;
  hasError: boolean;
  segmentCount: number;
  onSave: () => void;
  onSaveAs: () => void;
  onResetChanges: () => void;
  onCloseEditor: () => void;
};

export function EditorWorkspaceHeader({
  dirty,
  hasSavePath,
  busy,
  statusMessage,
  hasError,
  segmentCount,
  onSave,
  onSaveAs,
  onResetChanges,
  onCloseEditor
}: EditorWorkspaceHeaderProps) {
  const stateLabel = dirty ? "Unsaved Edits" : hasSavePath ? "Saved" : "In Memory";
  const showOperationMessage = hasError || (
    !/^Loaded \d+ editable segments\.$/.test(statusMessage.trim()) &&
    !/^Exported \d+ transcript file\(s\)\.$/.test(statusMessage.trim())
  );

  return (
    <section className="page-header compact-page-header transcription-page-header editor-workspace-header">
      <div className="editor-workspace-top-row">
        <h2 className="home-main-title">Transcript Editor</h2>
        <div className="editor-workspace-actions">
          {hasSavePath ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onSave}
              disabled={busy || !dirty}
              title={EDITOR_FIELD_HELP_TEXT.save}
            >
              Save
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={onSaveAs}
            disabled={busy}
            title={EDITOR_FIELD_HELP_TEXT.saveAs}
          >
            Save As…
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onResetChanges}
            disabled={busy || !dirty}
            title={EDITOR_FIELD_HELP_TEXT.resetChanges}
          >
            Reset
          </button>
          <button
            type="button"
            className="secondary-button danger-button"
            onClick={onCloseEditor}
            disabled={busy}
            title={EDITOR_FIELD_HELP_TEXT.closeEditor}
          >
            Close Editor
          </button>
        </div>
      </div>
      <div
        className={`editor-working-copy-status${dirty ? " dirty" : ""}${hasError ? " error" : ""}`}
        role={hasError ? "alert" : "status"}
      >
        <FieldLabelWithHelp
          label="Editing Copy"
          helpText={EDITOR_FIELD_HELP_TEXT.editingCopy}
          labelClassName="editor-working-copy-label"
        />
        <strong>{stateLabel}</strong>
        <span aria-hidden="true">·</span>
        <span>{segmentCount} {segmentCount === 1 ? "segment" : "segments"} loaded</span>
        {showOperationMessage ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="editor-working-copy-message">{statusMessage}</span>
          </>
        ) : null}
      </div>
    </section>
  );
}
