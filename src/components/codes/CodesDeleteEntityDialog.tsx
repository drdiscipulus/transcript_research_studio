import { useRef } from "react";

import { ModalDialog } from "../workbench/ModalDialog";

type CodesDeleteEntityDialogProps = {
  open: boolean;
  entityType: "code" | "theme";
  entityName: string;
  primaryImpact: string;
  secondaryImpact: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

export function CodesDeleteEntityDialog({
  open, entityType, entityName, primaryImpact, secondaryImpact, busy = false, error = null, onConfirm, onClose
}: CodesDeleteEntityDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const label = entityType === "code" ? "Code" : "Theme";
  return (
    <ModalDialog
      open={open}
      className="codes-delete-entity-dialog"
      role="alertdialog"
      title={`Delete ${label}`}
      description={<p>Delete <strong>{entityName}</strong>?</p>}
      initialFocusRef={cancelRef}
      cancelDisabled={busy}
      onCancel={onClose}
      footer={(
        <>
          <button type="button" className="secondary-button danger-button" disabled={busy} onClick={onConfirm}>Delete {label}</button>
          <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        </>
      )}
    >
      <div className="codes-delete-impact">
          <span>{primaryImpact}</span>
          <span>{secondaryImpact}</span>
      </div>
      <p className="muted-copy">The affected evidence items, codes, and themes themselves remain in the project unless stated otherwise above.</p>
      {error ? <div className="codes-ai-inline-message error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}
