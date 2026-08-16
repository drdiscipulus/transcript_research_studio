import { useRef } from "react";
import type { CodesEvidenceItem } from "../../lib/api";
import { ModalDialog } from "../workbench/ModalDialog";

type CodesEvidenceDeleteDialogProps = {
  evidence: CodesEvidenceItem | null;
  hasUnsavedChanges: boolean;
  busy: boolean;
  mutationLocked?: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

export function CodesEvidenceDeleteDialog({
  evidence,
  hasUnsavedChanges,
  busy,
  mutationLocked = false,
  error,
  onConfirm,
  onClose
}: CodesEvidenceDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const excerpt = evidence?.selected_text.trim() ?? "";
  const shortExcerpt = excerpt.length > 180 ? `${excerpt.slice(0, 177).trimEnd()}…` : excerpt;
  return (
    <ModalDialog
      open={Boolean(evidence)}
      instanceKey={evidence?.evidence_id}
      role="alertdialog"
      title="Delete Evidence"
      initialFocusRef={cancelRef}
      cancelDisabled={busy}
      onCancel={onClose}
      footer={(
        <>
          <button type="button" className="secondary-button danger-button" onClick={onConfirm} disabled={busy || mutationLocked}>
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        </>
      )}
    >
      {evidence ? (
        <div>
          <p>Delete evidence item <strong>{evidence.evidence_id}</strong>?</p>
          {shortExcerpt ? <blockquote>{shortExcerpt}</blockquote> : null}
          <p>This removes the evidence item from the coding project. The transcript and assigned codes remain unchanged.</p>
          {hasUnsavedChanges ? <p><strong>Unsaved inspector changes will also be discarded.</strong></p> : null}
        </div>
      ) : null}
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}
