import type { PreparedExport } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import { EDITOR_EXPORT_FORMATS, EDITOR_FIELD_HELP_TEXT } from "./editorConstants";

type EditorExportBarProps = {
  exportFormats: string[];
  outputFiles: PreparedExport[];
  busy: boolean;
  onExportFormatsChange: (formats: string[]) => void;
  onExport: () => void;
  onOpenOutputFolder: () => void;
};

export function EditorExportBar({
  exportFormats,
  outputFiles,
  busy,
  onExportFormatsChange,
  onExport,
  onOpenOutputFolder
}: EditorExportBarProps) {
  const createdFiles = outputFiles.filter((file) => file.exists);
  const createdFormats = Array.from(new Set(createdFiles.map((file) => file.format.toUpperCase())));

  return (
    <section className="section-card editor-workspace-export" aria-label="Export Transcript">
      <div className="editor-workspace-export-controls">
        <button type="button" className="primary-button" onClick={onExport} disabled={busy || exportFormats.length === 0}>
          Export Transcript
        </button>
        <div className="field-group editor-workspace-export-formats">
          <FieldLabelWithHelp label="Export Formats" helpText={EDITOR_FIELD_HELP_TEXT.exportFormats} />
          <div className="transcription-format-grid editor-format-row" role="group" aria-label="Export Formats">
            {EDITOR_EXPORT_FORMATS.map((format) => (
              <label key={format.value} className="transcription-plain-checkbox transcription-format-checkbox">
                <input
                  type="checkbox"
                  checked={exportFormats.includes(format.value)}
                  disabled={busy}
                  onChange={(event) => {
                    onExportFormatsChange(
                      event.target.checked
                        ? Array.from(new Set([...exportFormats, format.value]))
                        : exportFormats.filter((value) => value !== format.value)
                    );
                  }}
                />
                <span>{format.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {createdFiles.length > 0 ? (
        <div className="editor-workspace-export-result" role="status">
          <span>Created {createdFormats.join(", ")}.</span>
          <button type="button" className="secondary-button compact" onClick={onOpenOutputFolder} disabled={busy}>
            Open Output Folder
          </button>
        </div>
      ) : null}
    </section>
  );
}
