import { useRef } from "react";
import { appName } from "../../lib/appMetadata";
import { ModalDialog } from "./ModalDialog";

type CloseGuardDialogProps = {
  open: boolean;
  reasons: string[];
  onCancel: () => void;
  onConfirm: () => void;
};

export function CloseGuardDialog({ open, reasons, onCancel, onConfirm }: CloseGuardDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      open={open}
      className="close-guard-dialog"
      title={`Close ${appName}?`}
      description="Closing now can stop active work or discard changes that have not been saved."
      initialFocusRef={cancelButtonRef}
      onCancel={onCancel}
      footer={(
        <>
          <button ref={cancelButtonRef} type="button" className="secondary-button" onClick={onCancel}>
            Keep working
          </button>
          <button type="button" className="primary-button danger-button" onClick={onConfirm}>
            Close anyway
          </button>
        </>
      )}
    >
        <ul>
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
    </ModalDialog>
  );
}
