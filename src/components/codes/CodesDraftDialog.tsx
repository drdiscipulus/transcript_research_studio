import { useRef } from "react";

import { ModalDialog } from "../workbench/ModalDialog";

type CodesDraftDialogProps = {
  open: boolean;
  draftLabel: string;
  canSave: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
};

export function CodesDraftDialog({
  open,
  draftLabel,
  canSave,
  busy,
  onSave,
  onDiscard,
  onCancel
}: CodesDraftDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog
      open={open}
      className="codes-draft-dialog"
      role="alertdialog"
      title="Unsaved Draft"
      description={`${draftLabel} has changes that are not part of the saved coding project yet.`}
      initialFocusRef={saveRef}
      cancelDisabled={busy}
      onCancel={onCancel}
      footer={(
        <>
          <button ref={saveRef} type="button" className="primary-button" onClick={onSave} disabled={!canSave || busy}>
            Save Draft
          </button>
          <button type="button" className="secondary-button danger-button" onClick={onDiscard} disabled={busy}>
            Discard Draft
          </button>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      )}
    />
  );
}
