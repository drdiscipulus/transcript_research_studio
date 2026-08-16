import { useRef } from "react";

import type { EditorDocumentChoice } from "../../lib/api";
import { fileName, formatSeconds } from "../../lib/editorState";
import { ModalDialog } from "../workbench/ModalDialog";

type EditorDocumentSelectionDialogProps = {
  inspectedPath: string;
  documents: EditorDocumentChoice[];
  selectedDocumentId: string;
  loading: boolean;
  onSelect: (documentId: string) => void;
  onLoad: () => void;
  onCancel: () => void;
};

export function EditorDocumentSelectionDialog({
  inspectedPath,
  documents,
  selectedDocumentId,
  loading,
  onSelect,
  onLoad,
  onCancel
}: EditorDocumentSelectionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      open
      className="editor-document-selection-dialog"
      title="Choose Transcript"
      description={(
        <p>
          <strong>{fileName(inspectedPath)}</strong> contains more than one transcript. Choose the one you want to edit.
        </p>
      )}
      initialFocusRef={cancelRef}
      onCancel={onCancel}
      footer={(
        <>
          <button type="button" className="primary-button" onClick={onLoad} disabled={!selectedDocumentId || loading}>
            {loading ? "Loading…" : "Load Transcript"}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    >
      <div className="editor-document-choice-list" role="radiogroup" aria-label="Available transcripts">
          {documents.map((document) => (
            <label key={document.id} className="editor-document-choice">
              <input
                type="radio"
                name="editor-document-choice"
                value={document.id}
                checked={selectedDocumentId === document.id}
                disabled={loading}
                onChange={() => onSelect(document.id)}
              />
              <span>
                <strong>{document.label || document.file_name || document.id}</strong>
                <small>
                  {document.file_name || "Transcript"} · {document.segment_count} {document.segment_count === 1 ? "segment" : "segments"}
                  {document.duration === null ? "" : ` · ${formatSeconds(document.duration)}`}
                </small>
              </span>
            </label>
          ))}
      </div>
    </ModalDialog>
  );
}
