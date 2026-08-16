import { useRef } from "react";
import { ModalDialog } from "../workbench/ModalDialog";

type TranscriptionCancelDialogProps = {
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function TranscriptionCancelDialog({
  open,
  pending,
  onConfirm,
  onCancel
}: TranscriptionCancelDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      open={open}
      className="editor-confirmation-dialog"
      role="alertdialog"
      title="Stop Transcription?"
      description="Stop the current transcription run? Files that have already completed remain available."
      initialFocusRef={cancelRef}
      onCancel={onCancel}
      footer={(
        <>
          <button
            type="button"
            className="secondary-button danger-button"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Stopping..." : "Stop Transcription"}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    />
  );
}
